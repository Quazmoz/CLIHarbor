package main

import (
	"path/filepath"
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/discovery"
)

func TestParseToolOverrides(t *testing.T) {
	path := filepath.Join(string(filepath.Separator), "tools", "fixture")
	overrides, err := parseToolOverrides([]string{"demo/fixture=" + path})
	if err != nil {
		t.Fatalf("parseToolOverrides() error = %v", err)
	}
	ref := discovery.ToolRef{PackID: "demo", ToolID: "fixture"}
	if overrides[ref] != path {
		t.Fatalf("override = %q, want %q", overrides[ref], path)
	}
}

func TestParseToolOverridesRejectsMalformedAndDuplicates(t *testing.T) {
	for _, values := range [][]string{
		{"missing-equals"},
		{"demo=/tmp/tool"},
		{"demo/fixture="},
		{"demo/fixture=/one", "demo/fixture=/two"},
	} {
		if _, err := parseToolOverrides(values); err == nil {
			t.Fatalf("parseToolOverrides(%v) unexpectedly succeeded", values)
		}
	}
}
