package conjur

import (
	"fmt"
	"strings"

	"github.com/Quazmoz/CLIHarbor/internal/planner"
	"github.com/Quazmoz/CLIHarbor/internal/runs"
	"github.com/cyberark/conjur-api-go/conjurapi"
)

var loadMutationConjurConfig = conjurapi.LoadConfig

func TaskAvailable(packID, commandID string) bool {
	if packID != PackID || !strings.HasPrefix(commandID, "ldap-") {
		return true
	}
	config, err := loadMutationConjurConfig()
	if err != nil {
		return false
	}
	return !config.IsSaaS() &&
		validConjurHTTPSURL(config.ApplianceURL) &&
		validConjurConfigScalar(config.Account) &&
		validConjurConfigScalar(config.ServiceID)
}

func ResolveExecutionContext(plan planner.Plan) (runs.ExecutionContext, error) {
	if plan.PackID != PackID || plan.ToolID != ToolID {
		return runs.ExecutionContext{}, fmt.Errorf("no reviewed mutation context resolver for %s/%s", plan.PackID, plan.ToolID)
	}

	config, err := loadMutationConjurConfig()
	if err != nil ||
		!validConjurHTTPSURL(config.ApplianceURL) ||
		!validConjurConfigScalar(config.Account) {
		return runs.ExecutionContext{}, fmt.Errorf("Conjur execution context is unavailable")
	}
	if strings.HasPrefix(plan.CommandID, "ldap-") {
		if config.IsSaaS() || !validConjurConfigScalar(config.ServiceID) {
			return runs.ExecutionContext{}, fmt.Errorf("LDAP mutation context is unavailable")
		}
	}

	authMode := strings.ToLower(strings.TrimSpace(config.AuthnType))
	if authMode == "" {
		authMode = "authn"
	}
	if !validConjurConfigScalar(authMode) {
		return runs.ExecutionContext{}, fmt.Errorf("Conjur authentication context is invalid")
	}

	fields := []runs.ExecutionContextField{
		{Label: "Account", Value: config.Account},
		{Label: "Endpoint", Value: config.ApplianceURL},
		{Label: "Authentication", Value: authMode},
	}
	if config.ServiceID != "" {
		if !validConjurConfigScalar(config.ServiceID) {
			return runs.ExecutionContext{}, fmt.Errorf("Conjur service context is invalid")
		}
		fields = append(fields, runs.ExecutionContextField{Label: "Service ID", Value: config.ServiceID})
	}
	return runs.ExecutionContext{Fields: fields}, nil
}
