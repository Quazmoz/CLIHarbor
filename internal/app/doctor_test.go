package app

import (
	"bytes"
	"context"
	"strings"
	"testing"
)

func TestDoctorWithNoConfiguredPacksIsInformational(t *testing.T) {
	var out bytes.Buffer
	if err := Doctor(context.Background(), Options{Out: &out, Version: "test"}); err != nil {
		t.Fatalf("Doctor() error = %v", err)
	}
	if !strings.Contains(out.String(), "Configured packs: 0") || !strings.Contains(out.String(), "No packs configured") {
		t.Fatalf("doctor output = %q", out.String())
	}
}

func TestPrepareRuntimeRejectsMixedPackSources(t *testing.T) {
	_, err := prepareRuntime(context.Background(), Options{PackDirectory: "/packs", PackFiles: []string{"pack.yaml"}})
	if err == nil || !strings.Contains(err.Error(), "either --pack-dir or --pack-file") {
		t.Fatalf("error = %v, want mixed-source rejection", err)
	}
}
