package server

import (
	"net/http"
)

type TaskInputValidation struct {
	Min                 *int64   `json:"min,omitempty"`
	Max                 *int64   `json:"max,omitempty"`
	MinLength           *int     `json:"minLength,omitempty"`
	MaxLength           *int     `json:"maxLength,omitempty"`
	Pattern             string   `json:"pattern,omitempty"`
	Enum                []string `json:"enum,omitempty"`
	DisallowLeadingDash bool     `json:"disallowLeadingDash,omitempty"`
}

type TaskInput struct {
	ID         string              `json:"id"`
	Type       string              `json:"type"`
	Label      string              `json:"label"`
	Required   bool                `json:"required,omitempty"`
	Validation TaskInputValidation `json:"validation,omitempty"`
}

type Task struct {
	PackID      string      `json:"packId"`
	PackName    string      `json:"packName"`
	CommandID   string      `json:"commandId"`
	Name        string      `json:"name"`
	Description string      `json:"description,omitempty"`
	ToolID      string      `json:"toolId"`
	ToolVersion string      `json:"toolVersion,omitempty"`
	Inputs      []TaskInput `json:"inputs,omitempty"`
}

type TaskService interface {
	ListTasks() []Task
}

func (s *Server) handleTasks(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		writeAPIError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	tasks := s.tasks.ListTasks()
	if tasks == nil {
		tasks = []Task{}
	}
	writeJSON(w, http.StatusOK, struct {
		Tasks []Task `json:"tasks"`
	}{Tasks: tasks})
}
