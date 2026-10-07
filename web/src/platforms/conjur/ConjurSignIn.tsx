import { useEffect, useState } from 'react';
import { configureCredentialConnection, launchInteractiveLogin, loginWithCredentials } from '../../api/authentication';
import { normalizeError, type AppErrorDetail } from '../../api/errors';
import type { ToolDiagnostic } from '../../api/tools';
import type { SignInContext, ToolSignIn } from '../../AuthenticationPage';

// Dedicated Conjur sign-in (ADR-034): the connection/password form and the
// official vendor-login launcher. The generic Authentication page owns the
// session check and renders this only inside the dedicated Conjur section.
function ConjurSignIn({ status, tool, headingID, ready, checkKind, verifySession, onToolsChanged }: SignInContext) {
  const checking = checkKind === 'checking';
  const [credentialIdentity, setCredentialIdentity] = useState('');
  const [credentialSecret, setCredentialSecret] = useState('');
  const [credentialSubmitting, setCredentialSubmitting] = useState(false);
  const [credentialFailure, setCredentialFailure] = useState<AppErrorDetail | null>(null);
  const [vendorLoginOpened, setVendorLoginOpened] = useState(false);
  const [credentialConnectionReady, setCredentialConnectionReady] = useState(
    tool.credentialLogin?.method !== 'conjur-password' || tool.credentialLogin.setupRequired !== true,
  );
  const [credentialApplianceURL, setCredentialApplianceURL] = useState('');
  const [credentialAccount, setCredentialAccount] = useState('');
  const [credentialAuthnType, setCredentialAuthnType] = useState<'authn' | 'ldap'>('authn');
  const [credentialServiceID, setCredentialServiceID] = useState('');

  // A verified session ends the "sign-in started" notice (and its focus re-check).
  // Adjusted during render, per React guidance, rather than in an effect.
  const [seenCheckKind, setSeenCheckKind] = useState(checkKind);
  if (checkKind !== seenCheckKind) {
    setSeenCheckKind(checkKind);
    if (checkKind === 'authenticated') setVendorLoginOpened(false);
  }

  const submitCredentialConfiguration = async () => {
    if (
      tool.credentialLogin?.method !== 'conjur-password' ||
      !ready ||
      credentialConnectionReady ||
      credentialSubmitting ||
      checking
    ) {
      return;
    }

    const applianceUrl = credentialApplianceURL.trim();
    const account = credentialAccount.trim();
    const serviceId = credentialServiceID.trim();
    if (
      applianceUrl.length === 0 ||
      account.length === 0 ||
      (credentialAuthnType === 'ldap' && serviceId.length === 0)
    ) {
      return;
    }

    setCredentialSubmitting(true);
    setCredentialFailure(null);
    setCredentialSecret('');
    try {
      await configureCredentialConnection(status.csrfToken, {
        packId: tool.packId,
        toolId: tool.toolId,
        applianceUrl,
        account,
        authnType: credentialAuthnType,
        ...(credentialAuthnType === 'ldap' ? { serviceId } : {}),
      });
      setCredentialConnectionReady(true);
      // The runtime's capability snapshot still says setup is required; refresh it
      // so returning to this page later does not show the connection step again.
      onToolsChanged?.();
    } catch (error) {
      setCredentialFailure(normalizeError(error).detail);
    } finally {
      setCredentialSubmitting(false);
    }
  };

  const submitCredentialLogin = async () => {
    if (
      tool.credentialLogin?.method !== 'conjur-password' ||
      !ready ||
      !credentialConnectionReady ||
      credentialSubmitting ||
      checking
    ) {
      return;
    }

    const identity = credentialIdentity.trim();
    const secret = credentialSecret;
    if (identity.length === 0 || secret.length === 0) {
      return;
    }

    setCredentialSubmitting(true);
    setCredentialFailure(null);
    try {
      await loginWithCredentials(status.csrfToken, {
        packId: tool.packId,
        toolId: tool.toolId,
        identity,
        secret,
      });
      setCredentialSecret('');
      await verifySession();
    } catch (error) {
      setCredentialFailure(normalizeError(error).detail);
    } finally {
      setCredentialSecret('');
      setCredentialSubmitting(false);
    }
  };

  const launchVendorLogin = async () => {
    if (
      tool.credentialLogin?.method !== 'conjur-vendor-login' ||
      !ready ||
      credentialSubmitting ||
      checking
    ) {
      return;
    }

    setCredentialSubmitting(true);
    setCredentialFailure(null);
    setVendorLoginOpened(false);
    try {
      await launchInteractiveLogin(status.csrfToken, {
        packId: tool.packId,
        toolId: tool.toolId,
      });
      setVendorLoginOpened(true);
    } catch (error) {
      setCredentialFailure(normalizeError(error).detail);
    } finally {
      setCredentialSubmitting(false);
    }
  };

  // The vendor flow finishes in another browser tab or terminal; verify as soon as
  // the operator returns instead of requiring them to find Check session.
  useEffect(() => {
    if (!vendorLoginOpened) {
      return undefined;
    }
    // One automatic re-check per vendor login; later focus events must not keep adding runs.
    const recheck = () => {
      setVendorLoginOpened(false);
      void verifySession();
    };
    window.addEventListener('focus', recheck);
    return () => window.removeEventListener('focus', recheck);
  }); // Re-subscribes each render so the listener always sees the current check state.

  return (
    <>
      {ready && tool.credentialLogin === undefined && (
        <p className="auth-tool-meta">
          Sign in with your organization’s approved {tool.toolId} flow, then use the session check here to confirm it.
          {' If you expected the built-in Conjur password form, review Diagnostics and the Conjur connection/authentication mode instead of reinstalling the CLI.'}
        </p>
      )}

      {tool.credentialLogin?.method === 'conjur-password' && ready && (
        <form
          className="credential-login-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (credentialConnectionReady) {
              void submitCredentialLogin();
            } else {
              void submitCredentialConfiguration();
            }
          }}
        >
          <div className="credential-login-heading">
            <div>
              <p className="status-label">Conjur sign-in</p>
              <h4>{credentialConnectionReady ? 'Sign in to Conjur' : 'Connect to Conjur'}</h4>
            </div>
            <span className="safety-chip">{credentialConnectionReady ? 'Password stays local' : 'No password yet'}</span>
          </div>

          {!credentialConnectionReady && (
            <div className="credential-setup-section">
              <div>
                <p className="credential-step-label">Step 1 of 2 · Connection</p>
                <p className="credential-login-help" id={headingID + '-connection-help'}>
                  Enter the HTTPS server and account provided by your organization. Save the connection first;
                  you’ll enter your credentials in the next step.
                </p>
              </div>
              <div className="credential-login-fields">
                <label className="field">
                  <span>Conjur server URL</span>
                  <input
                    type="url"
                    name="conjur-appliance-url"
                    value={credentialApplianceURL}
                    maxLength={2048}
                    placeholder="https://conjur.example.com"
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={headingID + '-connection-help'}
                    disabled={credentialSubmitting || checking}
                    onChange={(event) => {
                      setCredentialApplianceURL(event.target.value);
                      setCredentialFailure(null);
                    }}
                    required
                  />
                </label>
                <label className="field">
                  <span>Account</span>
                  <input
                    type="text"
                    name="conjur-account"
                    value={credentialAccount}
                    maxLength={256}
                    autoComplete="off"
                    spellCheck={false}
                    aria-describedby={headingID + '-connection-help'}
                    disabled={credentialSubmitting || checking}
                    onChange={(event) => {
                      setCredentialAccount(event.target.value);
                      setCredentialFailure(null);
                    }}
                    required
                  />
                </label>
                <label className="field">
                  <span>Authentication method</span>
                  <select
                    name="conjur-authn-type"
                    value={credentialAuthnType}
                    aria-describedby={headingID + '-connection-help'}
                    disabled={credentialSubmitting || checking}
                    onChange={(event) => {
                      setCredentialAuthnType(event.target.value === 'ldap' ? 'ldap' : 'authn');
                      setCredentialFailure(null);
                    }}
                  >
                    <option value="authn">Conjur username and password</option>
                    <option value="ldap">LDAP username and password</option>
                  </select>
                </label>
                {credentialAuthnType === 'ldap' && (
                  <label className="field">
                    <span>LDAP authenticator service ID</span>
                    <input
                      type="text"
                      name="conjur-service-id"
                      value={credentialServiceID}
                      maxLength={256}
                      autoComplete="off"
                      spellCheck={false}
                      aria-describedby={headingID + '-connection-help'}
                      disabled={credentialSubmitting || checking}
                      onChange={(event) => {
                        setCredentialServiceID(event.target.value);
                        setCredentialFailure(null);
                      }}
                      required
                    />
                  </label>
                )}
              </div>
            </div>
          )}

          {credentialConnectionReady && (
            <div className="credential-setup-section">
              <div>
                {tool.credentialLogin.setupRequired === true && <p className="credential-step-label">Step 2 of 2 · Credentials</p>}
                <p id={headingID + '-credential-help'} className="credential-login-help">
                  Enter your normal Conjur identity and password. The password is sent only to this authenticated local runtime
                  for this attempt, never placed in command arguments or run history, and cleared from the form after submission.
                  Conjur remains responsible for its resulting vendor credential.
                </p>
              </div>
              <div className="credential-login-fields">
                <label className="field">
                  <span>Identity</span>
                  <input
                    type="text"
                    name="vendor-identity"
                    value={credentialIdentity}
                    maxLength={256}
                    autoComplete="username"
                    spellCheck={false}
                    aria-describedby={headingID + '-credential-help'}
                    disabled={credentialSubmitting || checking}
                    onChange={(event) => {
                      setCredentialIdentity(event.target.value);
                      setCredentialFailure(null);
                    }}
                    required
                  />
                </label>
                <label className="field">
                  <span>Password</span>
                  <input
                    type="password"
                    name="vendor-secret"
                    value={credentialSecret}
                    maxLength={4096}
                    autoComplete="current-password"
                    spellCheck={false}
                    aria-describedby={headingID + '-credential-help'}
                    disabled={credentialSubmitting || checking}
                    onChange={(event) => {
                      setCredentialSecret(event.target.value);
                      setCredentialFailure(null);
                    }}
                    required
                  />
                </label>
              </div>
            </div>
          )}

          {credentialFailure !== null && (
            <div className="credential-login-error" role="alert">
              <strong>{credentialFailure.message}</strong>
              {credentialFailure.remediation && <span>{credentialFailure.remediation}</span>}
            </div>
          )}
          <div className="credential-login-actions">
            <button
              type="submit"
              disabled={
                credentialSubmitting ||
                checking ||
                (credentialConnectionReady
                  ? credentialIdentity.trim().length === 0 || credentialSecret.length === 0
                  : credentialApplianceURL.trim().length === 0 ||
                    credentialAccount.trim().length === 0 ||
                    (credentialAuthnType === 'ldap' && credentialServiceID.trim().length === 0))
              }
            >
              {credentialSubmitting
                ? credentialConnectionReady
                  ? 'Signing in…'
                  : 'Saving connection…'
                : credentialConnectionReady
                  ? 'Sign in and verify'
                  : 'Save connection and continue'}
            </button>
          </div>
        </form>
      )}

      {tool.credentialLogin?.method === 'conjur-vendor-login' && ready && (
        <div className="credential-login-form">
          <div className="credential-login-heading">
            <div>
              <p className="status-label">Official Conjur sign-in</p>
              <h4>Continue with the vendor login flow</h4>
            </div>
            <span className="safety-chip">Credentials stay vendor-owned</span>
          </div>
          <p className="credential-login-help">
            Continue in Conjur’s browser or terminal to complete sign-in. Password and MFA prompts stay in the
            vendor terminal. When login finishes, the result stays visible until you close the window.
          </p>
          {credentialFailure !== null && (
            <div className="credential-login-error" role="alert">
              <strong>{credentialFailure.message}</strong>
              {credentialFailure.remediation && <span>{credentialFailure.remediation}</span>}
            </div>
          )}
          {vendorLoginOpened && (
            <div className="credential-login-success" role="status">
              <strong>Official Conjur sign-in started.</strong>
              <span>
                Complete any vendor browser or terminal flow. CLIHarbor re-checks the session when you return to this tab, or
                select Check session. If login fails, review the message in the terminal before closing it.
              </span>
            </div>
          )}
          <div className="credential-login-actions">
            <button
              type="button"
              disabled={credentialSubmitting || checking}
              onClick={() => void launchVendorLogin()}
            >
              {credentialSubmitting ? 'Starting Conjur sign-in…' : vendorLoginOpened ? 'Start Conjur sign-in again' : 'Start official Conjur sign-in'}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function signedOutDetail(tool: ToolDiagnostic): string | undefined {
  switch (tool.credentialLogin?.method) {
    case 'conjur-password':
      return 'Your Conjur session is signed out. Use the sign-in form below and CLIHarbor will verify the session automatically.';
    case 'conjur-vendor-login':
      return 'Your Conjur session is signed out. Start the official Conjur sign-in flow below, complete any vendor browser or terminal interaction, then re-check the session.';
    default:
      return undefined;
  }
}

const guidance = (
<details className="panel auth-guidance">
        <summary>How sign-in works</summary>
        <p>
          CLIHarbor never persists the password you enter. For supported Conjur password authentication, the browser submits it
          only to the authenticated loopback backend, which hands it directly to the pinned vendor API. The resulting vendor
          credential remains owned by Conjur's configured credential storage.
        </p>
        <p className="auth-guidance-step">
          When the current Conjur configuration uses a reviewed vendor-owned login mode such as OIDC, JWT, or Idira SaaS,
          CLIHarbor starts the exact verified Conjur CLI with fixed <code>login</code> argv. OIDC/JWT avoid an unnecessary
          console window; SaaS/cloud retains a vendor-owned terminal when interactive challenges require it. Unsupported
          modes such as certificate/IAM/Azure/GCP remain outside CLIHarbor and continue through your organization's approved flow.
        </p>
        <p>
          CLIHarbor’s local browser session is a separate trust boundary from vendor sessions. A successful sign-in still does
          not bypass backend task policy, and the session check remains the authoritative browser-visible evidence.
        </p>
      </details>
);

export const conjurSignIn: ToolSignIn = {
  render: (context) => <ConjurSignIn {...context} />,
  signedOutDetail,
  guidance,
};
