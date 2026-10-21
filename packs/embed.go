package packassets

import _ "embed"

// conjurV9 is the first-party Conjur pack shipped inside CLIHarbor. Keeping the
// executable pack bytes embedded removes a second download/trust step for the
// normal user path while preserving the explicit-local pack path for advanced
// and development workflows.
//
//go:embed conjur/conjur-v9.yaml
var conjurV9 []byte

// idiraPAM is the reviewed idsec v0.13 Privilege Cloud pack.
//go:embed idira/idira-pam.yaml
var idiraPAM []byte

// dockerCLI is the first-party read-only Docker inventory pack. Docker itself
// remains externally installed and authoritative; CLIHarbor does not provision
// or modify Docker.
//
//go:embed docker/docker.yaml
var dockerCLI []byte

// kubectlCLI is the first-party read-only Kubernetes inventory pack. kubectl
// remains externally installed and authoritative; CLIHarbor does not provision
// it, modify kubeconfig, or accept Kubernetes credentials.
//
//go:embed kubectl/kubectl.yaml
var kubectlCLI []byte

// githubCLI uses the official gh CLI's existing session for read-only metadata.
// CLIHarbor does not provision gh or accept GitHub credentials.
//
//go:embed github/github.yaml
var githubCLI []byte

// awsCLI, helmCLI and vaultCLI are read-only inventory packs that run under
// each vendor CLI's existing profile, kubeconfig, or token-helper session.
// Only Helm on Windows declares a managed install artifact.
//
//go:embed aws/aws.yaml
var awsCLI []byte

//go:embed helm/helm.yaml
var helmCLI []byte

//go:embed vault/vault.yaml
var vaultCLI []byte

// terraformCLI is the reviewed first-party Terraform pack: help-only tasks
// plus constrained local-state address inspection and typed-approved detachment.
// It never grants a browser-selected working directory or cloud operations.
//go:embed terraform/terraform.yaml
var terraformCLI []byte

// Builtins returns defensive copies of the first-party pack bytes that are safe
// to hand to the hardened pack loader.
func Builtins() map[string][]byte {
	return map[string][]byte{
		"conjur/conjur-v9.yaml":    append([]byte(nil), conjurV9...),
		"idira/idira-pam.yaml":     append([]byte(nil), idiraPAM...),
		"docker/docker.yaml":       append([]byte(nil), dockerCLI...),
		"kubectl/kubectl.yaml":     append([]byte(nil), kubectlCLI...),
		"github/github.yaml":       append([]byte(nil), githubCLI...),
		"aws/aws.yaml":             append([]byte(nil), awsCLI...),
		"helm/helm.yaml":           append([]byte(nil), helmCLI...),
		"vault/vault.yaml":         append([]byte(nil), vaultCLI...),
		"terraform/terraform.yaml": append([]byte(nil), terraformCLI...),
	}
}
