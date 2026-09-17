package main

import "testing"

func TestHasExpectedModuleLineAcceptsCommonLineEndings(t *testing.T) {
	t.Parallel()

	for _, content := range []string{
		moduleLine + "\n\ngo 1.27.0\n",
		moduleLine + "\r\n\r\ngo 1.27.0\r\n",
		"  " + moduleLine + "  \n",
	} {
		if !hasExpectedModuleLine([]byte(content)) {
			t.Fatalf("expected module line was not recognized in %q", content)
		}
	}
}

func TestHasExpectedModuleLineRejectsDifferentModule(t *testing.T) {
	t.Parallel()

	if hasExpectedModuleLine([]byte("module example.invalid/other\n")) {
		t.Fatal("unexpected module line accepted")
	}
}
