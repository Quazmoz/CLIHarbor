import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { configureCredentialConnection, launchInteractiveLogin, loginWithCredentials } from '../../api/authentication';
import { normalizeError, type AppErrorDetail } from '../../api/errors';
import type { ToolDiagnostic } from '../../api/tools';
import type { SignInContext, ToolSignIn } from '../../AuthenticationPage';
import { ConjurBackendConnection } from './ConjurBackendConnection';
import { useMutationActivity } from '../../OperationActivity';

// Dedicated Conjur sign-in (ADR-034, ADR-038): the login box holds only the
// password form or the official vendor-login launcher. Choosing the backend
// lives behind the card's settings button (ConjurSettings below).

function needsSetup(tool: ToolDiagnostic): boolean {
  return tool.credentialLogin?.method === 'conjur-password' && tool.credentialLogin.setupRequired === true;
}

function FailureAlert({ failure }: { failure: AppErrorDetail | null }) {
  if (failure === null) return null;
  return (
    <div className="credential-login-error" role="alert">
      <strong>{failure.message}</strong>
      {failure.remediation && <span>{failure.remediation}</span>}
    </div>
  );
}

function ConjurSignIn({ status, tool, headingID, ready, checkKind, verifySession, invalidateSession, openSettings, settingsOpen, busy }: SignInContext) {
  const checking = checkKind === 'checking';
  const [identity, setIdentity] = useState('');
  const [secret, setSecret] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<AppErrorDetail | null>(null);
  const [vendorLoginOpened, setVendorLoginOpened] = useState(false);
  const vendorLoginLeftPageRef = useRef(false);
  const beginChange = useMutationActivity();
  const disabled = submitting || checking || busy;

  // A verified session ends the "sign-in started" notice (and its focus re-check).
  // Adjusted during render, per React guidance, rather than in an effect.
  const [seenCheckKind, setSeenCheckKind] = useState(checkKind);
  if (checkKind !== seenCheckKind) {
    setSeenCheckKind(checkKind);
    if (checkKind === 'authenticated') setVendorLoginOpened(false);
  }

  const submitCredentialLogin = async () => {
    if (tool.credentialLogin?.method !== 'conjur-password' || needsSetup(tool) || !ready || disabled) return;
    const trimmedIdentity = identity.trim();
    if (trimmedIdentity.length === 0 || secret.length === 0) return;

    invalidateSession?.();
    const endChange = beginChange('Signing in to Conjur…', headingID);
    setSubmitting(true);
    setFailure(null);
    try {
      await loginWithCredentials(status.csrfToken, {
        packId: tool.packId,
        toolId: tool.toolId,
        identity: trimmedIdentity,
        secret,
      });
      setSecret('');
      await verifySession();
    } catch (error) {
      setFailure(normalizeError(error).detail);
    } finally {
      endChange();
      setSecret('');
      setSubmitting(false);
    }
  };

  const launchVendorLogin = async () => {
    if (tool.credentialLogin?.method !== 'conjur-vendor-login' || !ready || disabled) return;
    invalidateSession?.();
    const endChange = beginChange('Starting Conjur sign-in…', headingID);
    setSubmitting(true);
    setFailure(null);
    setVendorLoginOpened(false);
    vendorLoginLeftPageRef.current = false;
    try {
      await launchInteractiveLogin(status.csrfToken, { packId: tool.packId, toolId: tool.toolId });
      setVendorLoginOpened(true);
    } catch (error) {
      setFailure(normalizeError(error).detail);
    } finally {
      endChange();
      setSubmitting(false);
    }
  };

  // A vendor console may steal focus before the launch API responds. Track
  // departure while the request is in flight, but verify only after the
  // backend confirms that the vendor-owned login process was launched.
  const recheckOnReturn = useEffectEvent(() => {
    if (!vendorLoginOpened || !vendorLoginLeftPageRef.current || checking || document.visibilityState === 'hidden') return;
    vendorLoginLeftPageRef.current = false;
    setVendorLoginOpened(false);
    void verifySession();
  });
  useEffect(() => {
    if (!submitting && !vendorLoginOpened) return undefined;
    if (document.visibilityState === 'hidden') vendorLoginLeftPageRef.current = true;

    const markAway = () => { vendorLoginLeftPageRef.current = true; };
    const onFocus = () => recheckOnReturn();
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') markAway();
      else recheckOnReturn();
    };

    window.addEventListener('blur', markAway);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', markAway);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [submitting, vendorLoginOpened]);

  if (!ready) return null;

  if (tool.credentialLogin === undefined) {
    return (
      <p className="auth-tool-meta">
        Sign in with your organization’s approved {tool.toolId} flow, then use the session check here to confirm it.
        {' If you expected the built-in Conjur password form, review this CLI’s settings and Diagnostics instead of reinstalling the CLI.'}
      </p>
    );
  }

  if (needsSetup(tool)) {
    return (
      <div className="auth-setup-callout">
        <p>{settingsOpen ? 'Choose the Conjur server in settings below' : 'Choose the Conjur server this CLI should use'}, then sign in here.</p>
        {!settingsOpen && <button type="button" className="secondary-button" onClick={openSettings}>Configure backend</button>}
      </div>
    );
  }

  if (tool.credentialLogin.method === 'conjur-password') {
    return (
      <form className="credential-login-form" onSubmit={(event) => { event.preventDefault(); void submitCredentialLogin(); }}>
        <p id={headingID + '-credential-help'} className="credential-login-help">
          Your password goes only to this local runtime for this attempt. It is never stored, placed in command
          arguments or run history, and is cleared after you submit.
        </p>
        <div className="credential-login-fields">
          <label className="field">
            <span>Identity</span>
            <input type="text" name="vendor-identity" value={identity} maxLength={256} autoComplete="username"
              spellCheck={false} aria-describedby={headingID + '-credential-help'} disabled={disabled}
              onChange={(event) => { setIdentity(event.target.value); setFailure(null); }} required />
          </label>
          <label className="field">
            <span>Password</span>
            <input type="password" name="vendor-secret" value={secret} maxLength={4096} autoComplete="current-password"
              spellCheck={false} aria-describedby={headingID + '-credential-help'} disabled={disabled}
              onChange={(event) => { setSecret(event.target.value); setFailure(null); }} required />
          </label>
        </div>
        <FailureAlert failure={failure} />
        <div className="credential-login-actions">
          <button type="submit" disabled={disabled || identity.trim().length === 0 || secret.length === 0}>
            {submitting ? 'Signing in…' : 'Sign in and verify'}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="credential-login-form">
      <p className="credential-login-help">
        Conjur signs you in through its official browser or terminal flow. CLIHarbor never collects vendor credentials
        or MFA responses. Keep any terminal open until you have read the result.
      </p>
      <FailureAlert failure={failure} />
      {vendorLoginOpened && (
        <div className="credential-login-success" role="status">
          <strong>Official Conjur sign-in started.</strong>
          <span>CLIHarbor re-checks the session when you return to this tab, or select Check session.</span>
        </div>
      )}
      <div className="credential-login-actions">
        <button type="button" disabled={disabled} onClick={() => void launchVendorLogin()}>
          {submitting ? 'Starting Conjur sign-in…' : vendorLoginOpened ? 'Start Conjur sign-in again' : 'Start official Conjur sign-in'}
        </button>
      </div>
    </div>
  );
}

// First-run self-hosted connection. No password is collected here; once the
// runtime reports the connection configured, the login box shows the form.
function SelfHostedConnectionForm({ status, tool, headingID, checkKind, onToolsChanged, invalidateSession, busy }: SignInContext) {
  const [applianceURL, setApplianceURL] = useState('');
  const [account, setAccount] = useState('');
  const [authnType, setAuthnType] = useState<'authn' | 'ldap'>('authn');
  const [serviceID, setServiceID] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<AppErrorDetail | null>(null);
  const [saved, setSaved] = useState(false);
  const disabled = submitting || busy || checkKind === 'checking';
  const beginChange = useMutationActivity();
  const incomplete = applianceURL.trim().length === 0 || account.trim().length === 0 ||
    (authnType === 'ldap' && serviceID.trim().length === 0);
  const helpID = headingID + '-connection-help';

  const submit = async () => {
    if (disabled || incomplete) return;
    invalidateSession?.();
    const endChange = beginChange('Configuring Conjur connection…', headingID);
    setSubmitting(true);
    setFailure(null);
    try {
      await configureCredentialConnection(status.csrfToken, {
        packId: tool.packId,
        toolId: tool.toolId,
        applianceUrl: applianceURL.trim(),
        account: account.trim(),
        authnType,
        ...(authnType === 'ldap' ? { serviceId: serviceID.trim() } : {}),
      });
      setSaved(true);
      // The runtime recomputes setupRequired from the vendor configuration;
      // refreshing it swaps this card from setup to the sign-in form.
      onToolsChanged?.();
    } catch (error) {
      setFailure(normalizeError(error).detail);
    } finally {
      endChange();
      setSubmitting(false);
    }
  };

  return (
    <form className="credential-login-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <p className="credential-login-help" id={helpID}>
        Enter the HTTPS server and account provided by your organization.
      </p>
      <div className="credential-login-fields">
        <label className="field">
          <span>Conjur server URL</span>
          <input type="url" name="conjur-appliance-url" value={applianceURL} maxLength={2048}
            placeholder="https://conjur.example.com" autoComplete="off" spellCheck={false} aria-describedby={helpID}
            disabled={disabled} onChange={(event) => { setApplianceURL(event.target.value); setFailure(null); }} required />
        </label>
        <label className="field">
          <span>Account</span>
          <input type="text" name="conjur-account" value={account} maxLength={256} autoComplete="off" spellCheck={false}
            aria-describedby={helpID} disabled={disabled}
            onChange={(event) => { setAccount(event.target.value); setFailure(null); }} required />
        </label>
        <label className="field">
          <span>Authentication method</span>
          <select name="conjur-authn-type" value={authnType} aria-describedby={helpID} disabled={disabled}
            onChange={(event) => { setAuthnType(event.target.value === 'ldap' ? 'ldap' : 'authn'); setFailure(null); }}>
            <option value="authn">Conjur username and password</option>
            <option value="ldap">LDAP username and password</option>
          </select>
        </label>
        {authnType === 'ldap' && (
          <label className="field">
            <span>LDAP authenticator service ID</span>
            <input type="text" name="conjur-service-id" value={serviceID} maxLength={256} autoComplete="off"
              spellCheck={false} aria-describedby={helpID} disabled={disabled}
              onChange={(event) => { setServiceID(event.target.value); setFailure(null); }} required />
          </label>
        )}
      </div>
      <FailureAlert failure={failure} />
      {saved && <p role="status">Connection saved. Sign in from the card above.</p>}
      <div className="credential-login-actions">
        <button type="submit" disabled={disabled || incomplete}>{submitting ? 'Saving connection…' : 'Save connection'}</button>
      </div>
    </form>
  );
}

function ConjurSettings(context: SignInContext) {
  const [deployment, setDeployment] = useState<'self-hosted' | 'saas'>('self-hosted');
  const { status, tool, ready, onToolsChanged, invalidateSession, headingID, busy, checkKind } = context;
  if (!ready) return <p className="credential-login-help">Backend settings are available once the Conjur CLI is ready.</p>;
  const backend = <ConjurBackendConnection status={status} tool={tool} ready={ready}
    onToolsChanged={onToolsChanged} invalidateSession={invalidateSession} headingID={headingID}
    busy={busy || checkKind === 'checking'} />;

  return (
    <>
      {needsSetup(tool) ? (
        <>
          <fieldset className="auth-choice" disabled={busy}>
            <legend>Conjur backend</legend>
            <label>
              <input type="radio" name={headingID + '-deployment'} checked={deployment === 'self-hosted'}
                onChange={() => setDeployment('self-hosted')} />
              Self-hosted Conjur
            </label>
            <label>
              <input type="radio" name={headingID + '-deployment'} checked={deployment === 'saas'}
                onChange={() => setDeployment('saas')} />
              Secrets Manager SaaS
            </label>
          </fieldset>
          {deployment === 'self-hosted' ? <SelfHostedConnectionForm {...context} /> : backend}
        </>
      ) : backend}
      <details className="auth-guidance">
        <summary>How Conjur sign-in works</summary>
        <p>
          CLIHarbor never persists the password you enter. For Conjur password authentication, the browser submits it only to
          the authenticated loopback backend, which hands it directly to the pinned vendor API. The resulting vendor credential
          stays in Conjur’s configured credential storage.
        </p>
        <p>
          For vendor-owned login modes such as OIDC, JWT, or Idira SaaS, CLIHarbor starts the exact verified Conjur CLI with fixed
          <code> login</code> argv. Unsupported modes such as certificate/IAM/Azure/GCP continue through your organization’s
          approved flow. A successful sign-in never bypasses backend task policy.
        </p>
      </details>
    </>
  );
}

function signedOutDetail(tool: ToolDiagnostic): string | undefined {
  switch (tool.credentialLogin?.method) {
    case 'conjur-password':
      return 'Your Conjur session is signed out. Sign in below and CLIHarbor will verify the session automatically.';
    case 'conjur-vendor-login':
      return 'Your Conjur session is signed out. Start the official Conjur sign-in below, then re-check the session.';
    default:
      return undefined;
  }
}

export const conjurSignIn: ToolSignIn = {
  render: (context) => <ConjurSignIn {...context} />,
  settings: (context) => <ConjurSettings {...context} />,
  needsSetup,
  signedOutDetail,
};
