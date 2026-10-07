package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

type fakePlatformService struct{ platforms []Platform }

func (f fakePlatformService) ListPlatforms() []Platform { return f.platforms }

func TestPlatformAPIRequiresSessionAndListsDedicatedPlatforms(t *testing.T) {
	s := newTestServer(t, Config{Platforms: fakePlatformService{platforms: []Platform{{
		ID: "conjur", Name: "Conjur", PackID: "pack", ToolID: "tool", Ready: true,
		Features: []PlatformFeature{{ID: "security-audit", Name: "Security audit"}},
	}}}})

	unauthenticated, err := http.Get(s.BaseURL() + "/api/v1/platforms")
	if err != nil {
		t.Fatal(err)
	}
	unauthenticated.Body.Close()
	if unauthenticated.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", unauthenticated.StatusCode, http.StatusUnauthorized)
	}

	client := sessionClient(t)
	bootstrap(t, client, s)
	response, err := client.Get(s.BaseURL() + "/api/v1/platforms")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	var payload struct {
		Platforms []Platform `json:"platforms"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Platforms) != 1 || payload.Platforms[0].ID != "conjur" || !payload.Platforms[0].Ready || payload.Platforms[0].Features[0].ID != "security-audit" {
		t.Fatalf("platforms = %+v", payload.Platforms)
	}
}
