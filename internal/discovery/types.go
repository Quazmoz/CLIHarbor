package discovery

import "sort"

type Status string

const (
	StatusReady               Status = "ready"
	StatusMissing             Status = "missing"
	StatusAmbiguous           Status = "ambiguous"
	StatusIncompatible        Status = "incompatible"
	StatusProbeFailed         Status = "probe-failed"
	StatusInvalidOverride     Status = "invalid-override"
	StatusIdentityFailed      Status = "identity-failed"
	StatusUnsupportedPlatform Status = "unsupported-platform"
)

type ToolRef struct {
	PackID string `json:"packId"`
	ToolID string `json:"toolId"`
}

func (r ToolRef) String() string {
	if r.PackID == "" {
		return r.ToolID
	}
	return r.PackID + "/" + r.ToolID
}

type Candidate struct {
	Path           string `json:"path"`
	ExecutableName string `json:"executableName"`
}

type ToolState struct {
	PackID             string             `json:"packId"`
	PackVersion        string             `json:"packVersion"`
	ToolID             string             `json:"toolId"`
	Status             Status             `json:"status"`
	Path               string             `json:"path,omitempty"`
	ExecutableName     string             `json:"executableName,omitempty"`
	Version            string             `json:"version,omitempty"`
	VersionConstraint  string             `json:"versionConstraint,omitempty"`
	Candidates         []Candidate        `json:"candidates,omitempty"`
	Message            string             `json:"message,omitempty"`
	ExecutableIdentity ExecutableIdentity `json:"-"`
}

func (s ToolState) Healthy() bool {
	return s.Status == StatusReady
}

type Snapshot struct {
	tools []ToolState
	byRef map[ToolRef]int
}

func NewSnapshot(states []ToolState) Snapshot {
	ordered := append([]ToolState(nil), states...)
	for i := range ordered {
		ordered[i].Candidates = append([]Candidate(nil), ordered[i].Candidates...)
		sort.Slice(ordered[i].Candidates, func(a, b int) bool {
			return ordered[i].Candidates[a].Path < ordered[i].Candidates[b].Path
		})
	}
	sort.Slice(ordered, func(i, j int) bool {
		if ordered[i].PackID == ordered[j].PackID {
			return ordered[i].ToolID < ordered[j].ToolID
		}
		return ordered[i].PackID < ordered[j].PackID
	})
	byRef := make(map[ToolRef]int, len(ordered))
	for i, state := range ordered {
		byRef[ToolRef{PackID: state.PackID, ToolID: state.ToolID}] = i
	}
	return Snapshot{tools: ordered, byRef: byRef}
}

func (s Snapshot) Tools() []ToolState {
	out := make([]ToolState, len(s.tools))
	for i, state := range s.tools {
		out[i] = state
		out[i].Candidates = append([]Candidate(nil), state.Candidates...)
	}
	return out
}

func (s Snapshot) Find(ref ToolRef) (ToolState, bool) {
	index, ok := s.byRef[ref]
	if !ok {
		return ToolState{}, false
	}
	state := s.tools[index]
	state.Candidates = append([]Candidate(nil), state.Candidates...)
	return state, true
}

func (s Snapshot) Healthy() bool {
	for _, tool := range s.tools {
		if !tool.Healthy() {
			return false
		}
	}
	return true
}
