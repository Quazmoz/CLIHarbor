package packs

const (
	SupportedAPIVersion = "cliharbor.dev/v1"
	PackKind            = "CliPack"
)

type Risk string

const (
	RiskRead                Risk = "read"
	RiskChange              Risk = "change"
	RiskDestructive         Risk = "destructive"
	RiskCredentialSensitive Risk = "credential-sensitive"
	RiskInteractive         Risk = "interactive"
)

type AuthMode string

const (
	AuthModeVendorSession AuthMode = "vendor-session"
)

type InputType string

const (
	InputString      InputType = "string"
	InputInteger     InputType = "integer"
	InputBoolean     InputType = "boolean"
	InputEnum        InputType = "enum"
	InputMultiselect InputType = "multiselect"
)

type OutputMode string

const (
	OutputRaw       OutputMode = "raw"
	OutputJSON      OutputMode = "json"
	OutputNDJSON    OutputMode = "ndjson"
	OutputDelimited OutputMode = "delimited"
)

const VersionParserSemverText = "semver-text"

type Pack struct {
	APIVersion string             `json:"apiVersion"`
	Kind       string             `json:"kind"`
	Metadata   Metadata           `json:"metadata"`
	Runtime    Runtime            `json:"runtime"`
	Commands   map[string]Command `json:"commands"`
}

type Metadata struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Version     string `json:"version"`
	Description string `json:"description,omitempty"`
}

type Runtime struct {
	Platforms []string        `json:"platforms"`
	Tools     map[string]Tool `json:"tools"`
}

type Tool struct {
	ExecutableNames   []string             `json:"executableNames"`
	VersionProbe      *VersionProbe        `json:"versionProbe,omitempty"`
	HelpProbes        map[string]HelpProbe `json:"helpProbes,omitempty"`
	VersionConstraint string               `json:"versionConstraint,omitempty"`
}

type VersionProbe struct {
	Args          []string `json:"args,omitempty"`
	Parser        string   `json:"parser"`
	TimeoutMillis int      `json:"timeoutMillis,omitempty"`
}

// HelpProbe is an operator-invoked, fixed, read-only evidence probe. The
// executable still comes exclusively from trusted discovery state.
type HelpProbe struct {
	Args          []string `json:"args"`
	TimeoutMillis int      `json:"timeoutMillis,omitempty"`
}

type Command struct {
	Name         string       `json:"name"`
	Description  string       `json:"description,omitempty"`
	Tool         string       `json:"tool"`
	Risk         Risk         `json:"risk"`
	Inputs       []Input      `json:"inputs,omitempty"`
	Argv         []Argument   `json:"argv"`
	Output       Output       `json:"output"`
	Requirements Requirements `json:"requirements,omitempty"`
}

type Requirements struct {
	RequiresAuth bool     `json:"requiresAuth,omitempty"`
	AuthMode     AuthMode `json:"authMode,omitempty"`
}

type Input struct {
	ID         string          `json:"id"`
	Type       InputType       `json:"type"`
	Label      string          `json:"label"`
	Required   bool            `json:"required,omitempty"`
	Validation InputValidation `json:"validation,omitempty"`
}

type InputValidation struct {
	Min                 *int64   `json:"min,omitempty"`
	Max                 *int64   `json:"max,omitempty"`
	MinLength           *int     `json:"minLength,omitempty"`
	MaxLength           *int     `json:"maxLength,omitempty"`
	Pattern             string   `json:"pattern,omitempty"`
	Enum                []string `json:"enum,omitempty"`
	DisallowLeadingDash bool     `json:"disallowLeadingDash,omitempty"`
}

type Argument struct {
	Literal    string              `json:"literal,omitempty"`
	Flag       *FlagArgument       `json:"flag,omitempty"`
	Switch     *SwitchArgument     `json:"switch,omitempty"`
	Map        *MapArgument        `json:"map,omitempty"`
	Positional *PositionalArgument `json:"positional,omitempty"`
}

type FlagArgument struct {
	Name          string `json:"name"`
	ValueFrom     string `json:"valueFrom"`
	OmitWhenEmpty bool   `json:"omitWhenEmpty,omitempty"`
}

type SwitchArgument struct {
	Name        string `json:"name"`
	EnabledFrom string `json:"enabledFrom"`
}

type MapArgument struct {
	ValueFrom string            `json:"valueFrom"`
	Values    map[string]string `json:"values"`
}

// PositionalArgument maps one validated scalar input to exactly one argv
// element. It never tokenizes, templates, or reparses user-controlled text.
type PositionalArgument struct {
	ValueFrom     string `json:"valueFrom"`
	OmitWhenEmpty bool   `json:"omitWhenEmpty,omitempty"`
}

type StructuredFieldType string

const (
	StructuredString  StructuredFieldType = "string"
	StructuredInteger StructuredFieldType = "integer"
	StructuredBoolean StructuredFieldType = "boolean"
)

type StructuredOutput struct {
	Fields []StructuredField `json:"fields"`
}

type StructuredField struct {
	Key       string              `json:"key"`
	Label     string              `json:"label"`
	Type      StructuredFieldType `json:"type"`
	Required  bool                `json:"required,omitempty"`
	Sensitive bool                `json:"sensitive,omitempty"`
}

type Output struct {
	Mode        OutputMode        `json:"mode"`
	Renderer    string            `json:"renderer,omitempty"`
	Structured  *StructuredOutput `json:"structured,omitempty"`
	Sensitivity Sensitivity       `json:"sensitivity,omitempty"`
}

type Sensitivity struct {
	ContainsSecrets  bool `json:"containsSecrets,omitempty"`
	PersistRawOutput bool `json:"persistRawOutput,omitempty"`
	RevealByDefault  bool `json:"revealByDefault,omitempty"`
}

type SourceKind string

const (
	SourceBuiltin       SourceKind = "builtin"
	SourceExplicitLocal SourceKind = "explicit-local"
)

type Source struct {
	Kind SourceKind `json:"-"`
	Name string     `json:"-"`
}

type LoadedPack struct {
	Source Source `json:"-"`
	Pack   Pack   `json:"pack"`
}

type NamedTool struct {
	ID   string
	Tool Tool
}

type NamedCommand struct {
	ID      string
	Command Command
}
