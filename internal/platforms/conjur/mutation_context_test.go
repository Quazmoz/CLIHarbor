package conjur

import (
	"testing"

	"github.com/Quazmoz/CLIHarbor/internal/planner"
	"github.com/cyberark/conjur-api-go/conjurapi"
)

func TestMutationExecutionContextExposesOnlyReviewedNonSecretConjurFields(t *testing.T) {
	original := loadMutationConjurConfig
	t.Cleanup(func() { loadMutationConjurConfig = original })

	config := supportedConjurConfig()
	config.ServiceID = "corp"
	config.JWTFilePath = "SECRET_PATH_MUST_NOT_APPEAR"
	loadMutationConjurConfig = func() (conjurapi.Config, error) { return config, nil }

	context, err := ResolveExecutionContext(planner.Plan{
		PackID: "cyberark-conjur-v9", ToolID: "conjur", CommandID: "issuer-delete",
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(context.Fields) != 4 {
		t.Fatalf("context fields = %#v", context.Fields)
	}
	got := map[string]string{}
	for _, field := range context.Fields {
		got[field.Label] = field.Value
		if field.Value == config.JWTFilePath {
			t.Fatal("execution context leaked credential path")
		}
	}
	if got["Account"] != config.Account || got["Endpoint"] != config.ApplianceURL || got["Authentication"] != "authn" || got["Service ID"] != "corp" {
		t.Fatalf("context = %#v", got)
	}
}

func TestLDAPMutationTasksAreHiddenAndBlockedForSaaS(t *testing.T) {
	original := loadMutationConjurConfig
	t.Cleanup(func() { loadMutationConjurConfig = original })

	config := supportedConjurConfig()
	config.AuthnType = "ldap"
	config.ServiceID = "corp"
	loadMutationConjurConfig = func() (conjurapi.Config, error) { return config, nil }

	if !TaskAvailable("cyberark-conjur-v9", "ldap-group-create") {
		t.Fatal("reviewed non-SaaS LDAP task was hidden")
	}

	config.Environment = conjurapi.EnvironmentSaaS
	if TaskAvailable("cyberark-conjur-v9", "ldap-group-create") {
		t.Fatal("SaaS LDAP task was exposed")
	}
	if _, err := ResolveExecutionContext(planner.Plan{
		PackID: "cyberark-conjur-v9", ToolID: "conjur", CommandID: "ldap-group-delete",
	}); err == nil {
		t.Fatal("SaaS LDAP mutation context unexpectedly resolved")
	}
}

func TestMutationExecutionContextFailsClosedForUnreviewedTools(t *testing.T) {
	if _, err := ResolveExecutionContext(planner.Plan{
		PackID: "other", ToolID: "other", CommandID: "delete",
	}); err == nil {
		t.Fatal("unreviewed mutation tool unexpectedly received execution context")
	}
}
