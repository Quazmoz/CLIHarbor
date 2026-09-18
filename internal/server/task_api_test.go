package server

import (
	"encoding/json"
	"net/http"
	"testing"
)

type fakeTaskService struct {
	tasks []Task
}

func (f fakeTaskService) ListTasks() []Task {
	return append([]Task(nil), f.tasks...)
}

func TestTaskAPIRequiresSessionAndReturnsOnlyTaskDTO(t *testing.T) {
	service := fakeTaskService{tasks: []Task{{
		PackID:      "fixture",
		PackName:    "Fixture",
		CommandID:   "inspect",
		Name:        "Inspect",
		Description: "Safe fixture task",
		ToolID:      "fixture",
		ToolVersion: "1.2.3",
		Inputs: []TaskInput{{
			ID:       "query",
			Type:     "string",
			Label:    "Query",
			Required: true,
		}},
	}}}
	s := newTestServer(t, Config{Tasks: service})

	unauthenticated, err := http.Get(s.BaseURL() + "/api/v1/tasks")
	if err != nil {
		t.Fatal(err)
	}
	unauthenticated.Body.Close()
	if unauthenticated.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d, want %d", unauthenticated.StatusCode, http.StatusUnauthorized)
	}

	client := sessionClient(t)
	bootstrap(t, client, s)
	response, err := client.Get(s.BaseURL() + "/api/v1/tasks")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusOK)
	}

	var payload struct {
		Tasks []Task `json:"tasks"`
	}
	if err := json.NewDecoder(response.Body).Decode(&payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Tasks) != 1 || payload.Tasks[0].CommandID != "inspect" || len(payload.Tasks[0].Inputs) != 1 {
		t.Fatalf("task payload = %#v", payload.Tasks)
	}
}

func TestTaskAPIIsReadOnly(t *testing.T) {
	s := newTestServer(t, Config{Tasks: fakeTaskService{}})
	client := sessionClient(t)
	bootstrap(t, client, s)
	csrf := fetchStatus(t, client, s).CSRFToken

	request, err := http.NewRequest(http.MethodPost, s.BaseURL()+"/api/v1/tasks", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Origin", s.BaseURL())
	request.Header.Set(csrfHeaderName, csrf)
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want %d", response.StatusCode, http.StatusMethodNotAllowed)
	}
}
