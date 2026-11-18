// Package vault is CLIHarbor's dedicated HashiCorp Vault platform: a KV
// browser that lists key names and reveals one secret on explicit request
// through the official vault CLI and its existing vendor-owned session
// (ADR-045). CLIHarbor never accepts, stores, or injects a Vault token.
package vault

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/executor"
	"github.com/Quazmoz/CLIHarbor/internal/planner"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

const (
	PackID = "vault-cli"
	ToolID = "vault"

	// The vault CLI's documented default when VAULT_ADDR is unset.
	defaultAddress = "https://127.0.0.1:8200"
	commandTimeout = 10 * time.Second
	maxOutputBytes = 64 << 10
	revealMaxBytes = 16 << 10
	maxListKeys    = 1000
	maxFields      = 256
	accessLogLimit = 200
)

type runner func(ctx context.Context, executable string, args []string) (executor.ReadOnlyProbeResult, error)

type Platform struct {
	mu     sync.Mutex
	tool   discovery.ToolState
	log    []server.VaultAccessEntry
	slot   chan struct{}
	now    func() time.Time
	getenv func(string) string
	run    runner
}

func New(getenv func(string) string) *Platform {
	return &Platform{
		slot: make(chan struct{}, 1), now: time.Now, getenv: getenv,
		run: func(ctx context.Context, executable string, args []string) (executor.ReadOnlyProbeResult, error) {
			return executor.RunReadOnlyProbe(ctx, executable, args, executor.ReadOnlyProbeConfig{
				Timeout: commandTimeout, MaxOutputBytes: maxOutputBytes, VendorSession: true,
			})
		},
	}
}

func (p *Platform) Descriptor() server.Platform {
	return server.Platform{
		ID: "vault", Name: "HashiCorp Vault", PackID: PackID, ToolID: ToolID,
		Summary:  "Read-only server and mount metadata, a KV key browser, and explicit one-at-a-time secret reveal through the official vault CLI and its existing session.",
		Features: []server.PlatformFeature{{ID: "tasks", Name: "Vault tasks"}},
	}
}

func (p *Platform) ActivateTool(state discovery.ToolState) {
	if state.PackID != PackID || state.ToolID != ToolID {
		return
	}
	p.mu.Lock()
	p.tool = state
	p.mu.Unlock()
}

// Every vault-cli pack command is read-only metadata.
func (p *Platform) TaskAvailable(packID, _ string) bool { return packID == PackID }

func (p *Platform) ResolveExecutionContext(planner.Plan) (runs.ExecutionContext, error) {
	return runs.ExecutionContext{}, errors.New("Vault pack tasks cannot mutate Vault")
}

// Context reports the target the vendor CLI will use. An unparseable or
// credential-bearing VAULT_ADDR is never echoed back.
func (p *Platform) Context() server.VaultContext {
	out := server.VaultContext{Ready: p.toolReady()}
	address := strings.TrimSpace(p.getenv("VAULT_ADDR"))
	if address == "" {
		address = defaultAddress
	}
	if parsed, err := url.Parse(address); err == nil && (parsed.Scheme == "https" || parsed.Scheme == "http") &&
		parsed.Host != "" && parsed.User == nil && parsed.RawQuery == "" && parsed.Fragment == "" && displayText(address, 512) {
		out.Address = strings.TrimRight(address, "/")
	} else {
		out.Ready = false
	}
	if namespace := strings.Trim(p.getenv("VAULT_NAMESPACE"), "/"); namespace != "" {
		if server.ValidateVaultSecretRequest(server.VaultSecretRequest{Mount: namespace}, true) != nil {
			out.Ready = false
		} else {
			out.Namespace = namespace
		}
	}
	return out
}

func (p *Platform) List(ctx context.Context, request server.VaultSecretRequest) (server.VaultListResponse, error) {
	out := server.VaultListResponse{Mount: request.Mount, Path: request.Path, Keys: []string{}}
	stdout, code, err := p.execute(ctx, request, true, "list")
	if err != nil || code != "" {
		out.FailureCode = code
		return out, err
	}
	var keys []string
	if json.Unmarshal(stdout, &keys) != nil || len(keys) > maxListKeys {
		out.FailureCode = "invalid_response"
		return out, nil
	}
	for _, key := range keys {
		if !displayText(key, 512) {
			out.FailureCode = "invalid_response"
			return out, nil
		}
	}
	sort.Strings(keys)
	out.Keys = keys
	return out, nil
}

func (p *Platform) Reveal(ctx context.Context, request server.VaultSecretRequest) (server.VaultRevealResponse, error) {
	out := server.VaultRevealResponse{Mount: request.Mount, Path: request.Path}
	stdout, code, err := p.execute(ctx, request, false, "get")
	if err != nil {
		return out, err
	}
	// Go cannot erase decoded strings; this drops the raw buffer we own.
	defer clear(stdout)
	if code == "" {
		out.Fields, out.Version, code = parseSecret(stdout)
	}
	out.FailureCode = code
	outcome := code
	if outcome == "" {
		outcome = "revealed"
	}
	p.record(server.VaultAccessEntry{
		At: p.now().UTC().Format(time.RFC3339), Address: p.Context().Address,
		Mount: request.Mount, Path: request.Path, Outcome: outcome,
	})
	return out, nil
}

func (p *Platform) AccessLog() []server.VaultAccessEntry {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]server.VaultAccessEntry{}, p.log...)
}

func (p *Platform) record(entry server.VaultAccessEntry) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.log = append(p.log, entry)
	if len(p.log) > accessLogLimit {
		p.log = append([]server.VaultAccessEntry{}, p.log[len(p.log)-accessLogLimit:]...)
	}
}

func (p *Platform) toolReady() bool {
	p.mu.Lock()
	tool := p.tool
	p.mu.Unlock()
	return tool.Status == discovery.StatusReady && tool.Path != "" && tool.ExecutableIdentity.Valid() &&
		tool.ExecutableIdentity.Matches(tool.Path)
}

// execute runs exactly `vault kv <verb> -format=json <mount>/<path>`. The
// single target element starts with the validated alphanumeric mount, so it
// can never become a flag.
func (p *Platform) execute(ctx context.Context, request server.VaultSecretRequest, allowEmptyPath bool, verb string) ([]byte, string, error) {
	if err := server.ValidateVaultSecretRequest(request, allowEmptyPath); err != nil {
		return nil, "", err
	}
	if !p.toolReady() {
		return nil, "", server.ErrVaultUnavailable
	}
	if p.Context().Address == "" {
		return nil, "not_configured", nil
	}
	select {
	case p.slot <- struct{}{}:
		defer func() { <-p.slot }()
	default:
		return nil, "busy", nil
	}
	p.mu.Lock()
	tool := p.tool
	p.mu.Unlock()
	result, err := p.run(ctx, tool.Path, []string{"kv", verb, "-format=json", request.Mount + "/" + request.Path})
	if !tool.ExecutableIdentity.Matches(tool.Path) {
		clear(result.Stdout)
		return nil, "", server.ErrVaultUnavailable
	}
	switch {
	case err != nil || result.TimedOut || result.Cancelled:
		clear(result.Stdout)
		return nil, "unavailable", nil
	case result.Truncated:
		clear(result.Stdout)
		return nil, "output_limit_exceeded", nil
	case result.ExitCode != 0:
		clear(result.Stdout)
		// `vault kv list` reports an empty or missing folder as exit 2 with no stderr.
		if verb == "list" && result.ExitCode == 2 && len(bytes.TrimSpace(result.Stderr)) == 0 {
			return nil, "not_found", nil
		}
		return nil, failureCode(result.Stderr), nil
	}
	return result.Stdout, "", nil
}

// failureCode classifies vendor stderr without ever echoing it.
func failureCode(stderr []byte) string {
	text := strings.ToLower(string(stderr))
	switch {
	case strings.Contains(text, "missing client token"), strings.Contains(text, "invalid token"),
		strings.Contains(text, "token is expired"), strings.Contains(text, "code: 401"):
		return "session_required"
	case strings.Contains(text, "permission denied"), strings.Contains(text, "code: 403"):
		return "forbidden"
	case strings.Contains(text, "no value found"), strings.Contains(text, "code: 404"):
		return "not_found"
	case strings.Contains(text, "vault is sealed"), strings.Contains(text, "code: 503"):
		return "sealed"
	case strings.Contains(text, "connection refused"), strings.Contains(text, "no such host"),
		strings.Contains(text, "dial tcp"), strings.Contains(text, "certificate"):
		return "unreachable"
	}
	return "unavailable"
}

// parseSecret accepts `vault kv get -format=json` for KV v1 ({"data":{...}})
// and KV v2 ({"data":{"data":{...},"metadata":{"version":N}}}).
func parseSecret(stdout []byte) ([]server.VaultSecretField, int, string) {
	var envelope struct {
		Data map[string]json.RawMessage `json:"data"`
	}
	if json.Unmarshal(stdout, &envelope) != nil {
		return nil, 0, "invalid_response"
	}
	data, version := envelope.Data, 0
	// ponytail: KV v2 is inferred from the {data, metadata.version} shape; a KV v1
	// secret with exactly those two keys would be unwrapped. Upgrade path: read
	// the mount's options.version from `vault secrets list` first.
	if inner, hasData := data["data"]; hasData && len(data) == 2 {
		var metadata struct {
			Version int `json:"version"`
		}
		if raw, hasMetadata := data["metadata"]; hasMetadata && json.Unmarshal(raw, &metadata) == nil && metadata.Version > 0 {
			// A deleted or destroyed KV v2 version returns "data": null.
			data = nil
			if json.Unmarshal(inner, &data) != nil {
				return nil, 0, "invalid_response"
			}
			version = metadata.Version
		}
	}
	if data == nil {
		return nil, 0, "not_found"
	}
	if len(data) > maxFields {
		return nil, 0, "output_limit_exceeded"
	}
	fields := make([]server.VaultSecretField, 0, len(data))
	total := 0
	for key, raw := range data {
		if !displayText(key, 512) {
			return nil, 0, "invalid_response"
		}
		var value string
		if json.Unmarshal(raw, &value) != nil {
			var compact bytes.Buffer
			if json.Compact(&compact, raw) != nil {
				return nil, 0, "invalid_response"
			}
			value = compact.String()
		}
		total += len(key) + len(value)
		if total > revealMaxBytes {
			return nil, 0, "output_limit_exceeded"
		}
		fields = append(fields, server.VaultSecretField{Key: key, Value: value})
	}
	sort.Slice(fields, func(i, j int) bool { return fields[i].Key < fields[j].Key })
	return fields, version, ""
}

func displayText(value string, max int) bool {
	return value != "" && len(value) <= max && utf8.ValidString(value) &&
		strings.IndexFunc(value, func(r rune) bool {
			return unicode.IsControl(r) || unicode.Is(unicode.Cf, r) || r == '\u2028' || r == '\u2029'
		}) < 0
}
