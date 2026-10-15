package toolbootstrap

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
	"github.com/Quazmoz/CLIHarbor/internal/packs"
)

// A truncated managed copy must read as "not found" (so startup degrades) and
// Ensure must repair it instead of failing on the same verification error.
func TestCorruptManagedCopyIsNotFoundAndRepaired(t *testing.T) {
	payload := []byte("#!/bin/sh\necho 1.0.0\n")
	sum := sha256.Sum256(payload)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write(payload) }))
	defer srv.Close()
	p := &PortableProvisioner{client: srv.Client(), rootDir: t.TempDir(), goos: runtime.GOOS, goarch: runtime.GOARCH, allowInsecure: true}
	ref := discovery.ToolRef{PackID: "p", ToolID: "t"}
	tool := packs.Tool{Install: &packs.ToolInstall{Version: "1.0.0", Artifacts: map[string]packs.InstallArtifact{
		runtime.GOOS + "-" + runtime.GOARCH: {URL: srv.URL + "/x", SHA256: hex.EncodeToString(sum[:]), SizeBytes: int64(len(payload)), Format: packs.InstallFormatExecutable, ExecutableName: "tool"},
	}}}

	path, installed, err := p.Ensure(context.Background(), ref, tool)
	if err != nil || !installed {
		t.Fatalf("initial install: installed=%v err=%v", installed, err)
	}
	if err := os.WriteFile(path, []byte("x"), 0o700); err != nil {
		t.Fatal(err)
	}
	if _, found, err := p.ResolveInstalled(ref, tool); found || err != nil {
		t.Fatalf("corrupt copy: found=%v err=%v, want not found without error", found, err)
	}
	if _, installed, err := p.Ensure(context.Background(), ref, tool); err != nil || !installed {
		t.Fatalf("repair: installed=%v err=%v", installed, err)
	}
	if got, found, err := p.ResolveInstalled(ref, tool); !found || err != nil || got != path {
		t.Fatalf("after repair: path=%q found=%v err=%v", got, found, err)
	}
}
