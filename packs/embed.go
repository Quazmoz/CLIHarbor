package packassets

import _ "embed"

// conjurV9 is the first-party Conjur pack shipped inside CLIHarbor. Keeping the
// executable pack bytes embedded removes a second download/trust step for the
// normal user path while preserving the explicit-local pack path for advanced
// and development workflows.
//
//go:embed conjur/conjur-v9.yaml
var conjurV9 []byte

// Builtins returns defensive copies of the first-party pack bytes that are safe
// to hand to the hardened pack loader.
func Builtins() map[string][]byte {
	return map[string][]byte{
		"conjur/conjur-v9.yaml": append([]byte(nil), conjurV9...),
	}
}
