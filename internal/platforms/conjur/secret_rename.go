package conjur

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/Quazmoz/CLIHarbor/internal/server"
)

const renameLimit = 100

var renamePath = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$`)

type renameRunner interface {
	Preview(runs.Request) (runs.Preview, error)
	Start(runs.Request) (runs.Snapshot, error)
	Wait(context.Context, string) (runs.Snapshot, error)
	Cancel(string) error
}

type renameGrant struct {
	Role      string `json:"role"`
	Privilege string `json:"privilege"`
	Policy    string `json:"policy"`
}

type renameAnnotation struct {
	Name   string `json:"name"`
	Value  string `json:"value"`
	Policy string `json:"policy"`
}

type renameMetadata struct {
	ID          string                 `json:"id"`
	Owner       string                 `json:"owner"`
	Policy      string                 `json:"policy"`
	Permissions []renameGrant          `json:"permissions"`
	Annotations []renameAnnotation     `json:"annotations"`
	Versions    []server.SecretVersion `json:"-"`
}

type renameSnapshot struct {
	Metadata renameMetadata
	Values   []string
}

type renameApproval struct {
	request           server.SecretRenameRequest
	digest            [32]byte
	salt              string
	expires           time.Time
	copied            bool
	mapping           []server.SecretVersionMapping
	destinationDigest [32]byte
}

// Only metadata and salted fingerprints survive a request. Every mutation is
// an ordinary reviewed pack task, with the run manager's durable audit gate.
type SecretRenameService struct {
	mu       sync.Mutex
	approval *renameApproval
	secrets  *SecretRetrievalService
	login    *CredentialLoginService
	runner   renameRunner
	now      func() time.Time
}

func NewSecretRenameService(secrets *SecretRetrievalService, login *CredentialLoginService, runner renameRunner) *SecretRenameService {
	return &SecretRenameService{secrets: secrets, login: login, runner: runner, now: time.Now}
}

type renameFailure string

func (e renameFailure) Error() string { return string(e) }

func (s *SecretRenameService) Rename(ctx context.Context, action string, request server.SecretRenameRequest) (server.SecretRenameResponse, error) {
	out := server.SecretRenameResponse{
		Source: request.Target.VariableID, Destination: request.Destination,
		Versions: []server.SecretVersionMapping{}, RunIDs: []string{}, Status: "stopped",
	}
	if server.ValidateSecretRetrievalRequest(request.Target) != nil || request.Target.Version != 0 ||
		!renamePath.MatchString(request.Target.VariableID) || !renamePath.MatchString(request.Destination) ||
		request.Target.VariableID == request.Destination || len(request.Destination) > 2048 ||
		(action != "review" && action != "copy" && action != "delete" && action != "discard") {
		return out, server.ErrSecretRetrievalInvalidRequest
	}
	// This vendor namespace retrieves newly issued credentials, not static
	// history. Refuse it before any value read (Issuer::DYNAMIC_VARIABLE_PREFIX).
	if strings.HasPrefix(request.Target.VariableID, "data/dynamic/") || strings.HasPrefix(request.Destination, "data/dynamic/") {
		out.FailureCode = "unsupported_dynamic"
		return out, nil
	}
	if !s.mu.TryLock() {
		out.FailureCode = "busy"
		return out, nil
	}
	defer s.mu.Unlock()
	// Review/copy authorizations are intentionally single-flight. Never evict
	// an outstanding cutover approval just because another tab asks to review.
	if action == "review" && s.approval != nil && s.now().Before(s.approval.expires) {
		out.FailureCode = "approval_pending"
		return out, nil
	}
	err := s.rename(ctx, action, request, &out)
	if err != nil {
		var failure renameFailure
		if errors.As(err, &failure) {
			out.FailureCode = string(failure)
		} else {
			out.FailureCode = "unavailable"
		}
	}
	return out, nil
}

func (s *SecretRenameService) prepare(request server.SecretRetrievalRequest) (secretRetrievalClient, error) {
	s.login.mu.RLock()
	ready := s.login.executableReady()
	s.login.mu.RUnlock()
	if !ready {
		return nil, renameFailure("tool_changed")
	}
	client, _, code, err := s.secrets.prepare(request)
	if err != nil {
		return nil, renameFailure("unavailable")
	}
	if code != "" {
		return nil, renameFailure(code)
	}
	return client, nil
}

func (s *SecretRenameService) rename(ctx context.Context, action string, request server.SecretRenameRequest, out *server.SecretRenameResponse) error {
	if err := ctx.Err(); err != nil {
		return renameFailure("interrupted")
	}
	var approval *renameApproval
	if action != "review" {
		approval = s.approval
		// The token is bound to the exact account/backend/source/destination.
		if approval == nil || !s.now().Before(approval.expires) ||
			request.ApprovalID == "" || request.ApprovalID != approval.request.ApprovalID ||
			request.Target != approval.request.Target || request.Destination != approval.request.Destination ||
			(action != "discard" && approval.copied != (action == "delete")) {
			return renameFailure("approval_required")
		}
		if action == "discard" {
			s.approval = nil
			out.Status = "discarded"
			return nil
		}
		if action == "delete" && request.Confirmation != "DELETE: "+request.Target.VariableID {
			return renameFailure("confirmation_required")
		}
		// Consume before touching the vendor. A lost acknowledgement must not
		// turn a repeated HTTP request into another write.
		s.approval = nil
	}
	client, err := s.prepare(request.Target)
	if err != nil {
		return err
	}
	source, err := s.snapshot(ctx, client, request.Target)
	if err != nil {
		return err
	}
	defer clear(source.Values)
	meta := source.Metadata
	if len(source.Values) == 0 {
		return renameFailure("unsupported_history")
	}
	out.Owner, out.Policy = meta.Owner, meta.Policy
	out.Grants, out.Annotations = len(meta.Permissions), len(meta.Annotations)
	branch := strings.TrimPrefix(meta.Policy, request.Target.Account+":policy:")
	if _, ok := relativeRenameID(request.Destination, branch); !ok {
		return renameFailure("different_policy")
	}
	for _, grant := range meta.Permissions {
		grantBranch := strings.TrimPrefix(grant.Policy, request.Target.Account+":policy:")
		if _, ok := relativeRenameID(request.Destination, grantBranch); !ok {
			return renameFailure("unsupported_grant")
		}
	}
	if action == "review" {
		if request.ApprovalID != "" || request.Confirmation != "" {
			return renameFailure("approval_required")
		}
		if err := renameDestinationAbsent(client, request); err != nil {
			return err
		}
		var token [32]byte
		if _, err := rand.Read(token[:]); err != nil {
			return renameFailure("unavailable")
		}
		request.ApprovalID = hex.EncodeToString(token[:])
		approval = &renameApproval{request: request, salt: request.ApprovalID, expires: s.now().Add(2 * time.Minute)}
		approval.digest = renameDigest(source, approval.salt)
		// Validate every pack step before granting workflow authority, without
		// ever exposing a secret-bearing preview to the browser.
		steps := renameSteps(request, source)
		for _, step := range steps {
			if _, err := s.preview(request.Target, step); err != nil {
				return err
			}
		}
		s.approval = approval
		out.ApprovalID, out.ExpiresAt = request.ApprovalID, approval.expires.UTC().Format(time.RFC3339)
		for _, version := range meta.Versions {
			out.Versions = append(out.Versions, server.SecretVersionMapping{Source: version.Version})
		}
		out.Status = "reviewed"
		return nil
	}
	if renameDigest(source, approval.salt) != approval.digest {
		return renameFailure("source_changed")
	}
	if action == "copy" {
		if err := renameDestinationAbsent(client, request); err != nil {
			return err
		}
		metadataVerified := false
		for _, step := range renameSteps(request, source) {
			if step.CommandID == "secret-set-value" && !metadataVerified {
				target := request.Target
				target.VariableID = request.Destination
				empty, err := s.snapshot(ctx, client, target)
				if err != nil {
					return err
				}
				matches := len(empty.Values) == 0 && sameRenameMetadata(meta, empty.Metadata)
				clear(empty.Values)
				if !matches {
					return renameFailure("verification_failed")
				}
				metadataVerified = true
			}
			if err := s.execute(ctx, request.Target, step, out); err != nil {
				return err
			}
		}
	}
	destinationRequest := request.Target
	destinationRequest.VariableID = request.Destination
	destination, err := s.snapshot(ctx, client, destinationRequest)
	if err != nil {
		return err
	}
	defer clear(destination.Values)
	if !sameRenamedSecret(source, destination) {
		return renameFailure("verification_failed")
	}
	for i, version := range meta.Versions {
		out.Versions = append(out.Versions, server.SecretVersionMapping{Source: version.Version, Destination: destination.Metadata.Versions[i].Version})
	}
	if action == "delete" && !reflect.DeepEqual(out.Versions, approval.mapping) {
		return renameFailure("destination_changed")
	}
	if action == "delete" && renameDigest(destination, approval.salt) != approval.destinationDigest {
		return renameFailure("destination_changed")
	}
	// Check source again after reading/copying all versions. Conjur offers no
	// CAS/delete precondition: operators must pause external writers at cutover.
	current, err := s.snapshot(ctx, client, request.Target)
	if err != nil {
		return err
	}
	defer clear(current.Values)
	if renameDigest(current, approval.salt) != approval.digest {
		return renameFailure("source_changed")
	}
	if action == "copy" {
		var token [32]byte
		if _, err := rand.Read(token[:]); err != nil {
			return renameFailure("unavailable")
		}
		approval.request.ApprovalID = hex.EncodeToString(token[:])
		approval.copied, approval.expires, approval.mapping = true, s.now().Add(time.Hour), slices.Clone(out.Versions)
		approval.destinationDigest = renameDigest(destination, approval.salt)
		s.approval = approval
		out.ApprovalID, out.ExpiresAt = approval.request.ApprovalID, approval.expires.UTC().Format(time.RFC3339)
		out.Status = "copied"
		return nil
	}
	relative, _ := relativeRenameID(request.Target.VariableID, branch)
	step := renameTask("secret-delete", map[string]string{"policy-branch": branch, "variable-id": relative})
	if err := s.execute(ctx, request.Target, step, out); err != nil {
		return err
	}
	// A successful CLI exit is not enough to claim that deletion took effect.
	if err := renameResourceAbsent(client, request.Target.Account+":variable:"+request.Target.VariableID); err != nil {
		return renameFailure("deletion_unconfirmed")
	}
	out.Status = "deleted"
	return nil
}

func renameDestinationAbsent(client secretRetrievalClient, request server.SecretRenameRequest) error {
	return renameResourceAbsent(client, request.Target.Account+":variable:"+request.Destination)
}

func renameResourceAbsent(client secretRetrievalClient, id string) error {
	_, err := client.Resource(id)
	if err == nil {
		return renameFailure("destination_exists")
	}
	if secretRetrievalCode(err) != "not_found" {
		return renameFailure(secretRetrievalCode(err))
	}
	return nil
}

func relativeRenameID(id, branch string) (string, bool) {
	if branch == "root" {
		return id, true
	}
	relative, found := strings.CutPrefix(id, branch+"/")
	return relative, found && relative != ""
}

func (s *SecretRenameService) snapshot(ctx context.Context, client secretRetrievalClient, target server.SecretRetrievalRequest) (renameSnapshot, error) {
	var out renameSnapshot
	fullID := target.Account + ":variable:" + target.VariableID
	raw, err := client.Resource(fullID)
	if err != nil {
		return out, renameFailure(secretRetrievalCode(err))
	}
	encoded, err := json.Marshal(raw)
	if err != nil || len(encoded) > 256<<10 || json.Unmarshal(encoded, &out.Metadata) != nil {
		return out, renameFailure("invalid_response")
	}
	meta := &out.Metadata
	validID := func(id, kind string) bool {
		prefix := target.Account + ":" + kind + ":"
		return strings.HasPrefix(id, prefix) && renamePath.MatchString(strings.TrimPrefix(id, prefix))
	}
	role := func(id string, owner bool) bool {
		for _, kind := range []string{"user", "host", "group", "layer", "policy"} {
			if validID(id, kind) && (owner || kind != "policy") {
				return true
			}
		}
		return false
	}
	if meta.ID != fullID || !role(meta.Owner, true) || !validID(meta.Policy, "policy") ||
		meta.Permissions == nil || meta.Annotations == nil ||
		len(meta.Permissions) > renameLimit || len(meta.Annotations) > renameLimit {
		return out, renameFailure("unsupported_metadata")
	}
	branch := strings.TrimPrefix(meta.Policy, target.Account+":policy:")
	if _, ok := relativeRenameID(target.VariableID, branch); !ok {
		return out, renameFailure("unsupported_metadata")
	}
	seen := map[renameGrant]bool{}
	for _, grant := range meta.Permissions {
		if !role(grant.Role, false) || !validID(grant.Policy, "policy") ||
			(grant.Privilege != "read" && grant.Privilege != "execute" && grant.Privilege != "update") || seen[grant] {
			return out, renameFailure("unsupported_grant")
		}
		seen[grant] = true
	}
	names := map[string]bool{}
	for _, annotation := range meta.Annotations {
		if annotation.Name == "" || len(annotation.Name) > 512 || len(annotation.Value) > 4096 ||
			!utf8.ValidString(annotation.Name) || !utf8.ValidString(annotation.Value) ||
			annotation.Policy != meta.Policy || names[annotation.Name] ||
			strings.HasPrefix(annotation.Name, "rotation/") ||
			strings.HasPrefix(annotation.Name, "dynamic/") ||
			(strings.HasPrefix(annotation.Name, "conjur/") && annotation.Name != "conjur/mime_type") {
			return out, renameFailure("unsupported_annotation")
		}
		names[annotation.Name] = true
	}
	slices.SortFunc(meta.Permissions, func(a, b renameGrant) int {
		return strings.Compare(a.Policy+"\x00"+a.Role+"\x00"+a.Privilege, b.Policy+"\x00"+b.Role+"\x00"+b.Privilege)
	})
	slices.SortFunc(meta.Annotations, func(a, b renameAnnotation) int { return strings.Compare(a.Name, b.Name) })
	versions, ok := raw["secrets"].([]interface{})
	if !ok || len(versions) > renameLimit {
		return out, renameFailure("unsupported_history")
	}
	meta.Versions, ok = parseSecretVersions(versions)
	if !ok {
		return out, renameFailure("invalid_response")
	}
	slices.Reverse(meta.Versions)
	for _, version := range meta.Versions {
		if ctx.Err() != nil {
			clear(out.Values)
			return out, renameFailure("interrupted")
		}
		value, code := readSecret(client, fullID, version.Version)
		outcome := "rename_read"
		if code != "" {
			outcome = code
		}
		s.secrets.record(server.SecretAccessEntry{
			At: s.now().UTC().Format(time.RFC3339), Account: target.Account, ApplianceURL: target.ApplianceURL,
			VariableID: target.VariableID, Version: version.Version, Outcome: outcome,
		})
		if code != "" {
			clear(out.Values)
			return out, renameFailure(code)
		}
		// Use the existing reviewed write contract; do not silently truncate or
		// broaden it to migrate binary, empty or oversized historical values.
		if utf8.RuneCountInString(value) > 4096 || strings.TrimSpace(value) == "" {
			clear(out.Values)
			return out, renameFailure("unsupported_value")
		}
		out.Values = append(out.Values, value)
	}
	return out, nil
}

func renameDigest(snapshot renameSnapshot, salt string) [32]byte {
	// Metadata contains strings only and was decoded from bounded JSON.
	payload, _ := json.Marshal(struct {
		Salt     string
		Snapshot renameSnapshot
		Versions []server.SecretVersion
	}{salt, snapshot, snapshot.Metadata.Versions})
	defer clear(payload)
	return sha256.Sum256(payload)
}

func sameRenamedSecret(a, b renameSnapshot) bool {
	return sameRenameMetadata(a.Metadata, b.Metadata) && slices.Equal(a.Values, b.Values)
}

func sameRenameMetadata(a, b renameMetadata) bool {
	a.ID, b.ID = "", ""
	a.Versions, b.Versions = nil, nil
	return reflect.DeepEqual(a, b)
}

func renameTask(command string, values map[string]string) runs.Request {
	request := runs.Request{PackID: PackID, CommandID: command, Values: map[string]json.RawMessage{}}
	for key, value := range values {
		request.Values[key], _ = json.Marshal(value)
	}
	return request
}

func renameSteps(request server.SecretRenameRequest, source renameSnapshot) []runs.Request {
	meta := source.Metadata
	branch := strings.TrimPrefix(meta.Policy, request.Target.Account+":policy:")
	relative, _ := relativeRenameID(request.Destination, branch)
	owner := strings.SplitN(meta.Owner, ":", 3)
	steps := []runs.Request{renameTask("secret-create-owned", map[string]string{
		"policy-branch": branch, "variable-id": relative, "owner-kind": owner[1], "owner-id": "/" + owner[2],
	})}
	for _, annotation := range meta.Annotations {
		steps = append(steps, renameTask("secret-annotate-owned", map[string]string{
			"policy-branch": branch, "variable-id": relative, "owner-kind": owner[1], "owner-id": "/" + owner[2],
			"annotation-name": annotation.Name, "annotation-value": annotation.Value,
		}))
	}
	for _, grant := range meta.Permissions {
		grantBranch := strings.TrimPrefix(grant.Policy, request.Target.Account+":policy:")
		relative, _ := relativeRenameID(request.Destination, grantBranch)
		role := strings.SplitN(grant.Role, ":", 3)
		steps = append(steps, renameTask("secret-permit", map[string]string{
			"policy-branch": grantBranch, "variable-id": relative,
			"role-kind": role[1], "role-id": "/" + role[2], "privileges": grant.Privilege,
		}))
	}
	for _, value := range source.Values {
		steps = append(steps, renameTask("secret-set-value", map[string]string{
			"variable-id": request.Target.Account + ":variable:" + request.Destination, "value": value,
		}))
	}
	return steps
}

func (s *SecretRenameService) preview(target server.SecretRetrievalRequest, request runs.Request) (runs.Preview, error) {
	preview, err := s.runner.Preview(request)
	if err != nil || preview.Approval == nil || preview.Context == nil {
		return runs.Preview{}, renameFailure("plan_unavailable")
	}
	fields := map[string]string{}
	for _, field := range preview.Context.Fields {
		fields[field.Label] = field.Value
	}
	if fields["Account"] != target.Account || strings.TrimRight(fields["Endpoint"], "/") != strings.TrimRight(target.ApplianceURL, "/") {
		return runs.Preview{}, renameFailure("context_mismatch")
	}
	return preview, nil
}

func (s *SecretRenameService) execute(ctx context.Context, target server.SecretRetrievalRequest, request runs.Request, out *server.SecretRenameResponse) error {
	if ctx.Err() != nil {
		return renameFailure("interrupted")
	}
	if _, err := s.prepare(target); err != nil {
		return err
	}
	preview, err := s.preview(target, request)
	if err != nil {
		return err
	}
	request.Approval = &runs.ApprovalSubmission{ID: preview.Approval.ID, Confirmation: preview.Approval.RequiredText}
	started, err := s.runner.Start(request)
	if err != nil {
		return renameFailure("write_unconfirmed")
	}
	out.RunIDs = append(out.RunIDs, started.RunID)
	completed, err := s.runner.Wait(ctx, started.RunID)
	if err != nil {
		if cancelErr := s.runner.Cancel(started.RunID); cancelErr != nil {
			return renameFailure("cancellation_unconfirmed")
		}
		return renameFailure("write_unconfirmed")
	}
	if completed.Status != runs.StatusExited || completed.ExitCode == nil || *completed.ExitCode != 0 || completed.Failure != nil {
		return renameFailure("write_unconfirmed")
	}
	return nil
}

var _ server.SecretRenameService = (*SecretRenameService)(nil)
