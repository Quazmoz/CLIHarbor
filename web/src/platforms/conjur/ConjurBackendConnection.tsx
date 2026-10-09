import { useEffect, useRef, useState } from 'react';
import { configureCredentialConnection, getVendorConnection, type VendorConnection } from '../../api/authentication';
import { normalizeError } from '../../api/errors';
import type { SignInContext } from '../../AuthenticationPage';

// Vendor setup, not a web bookmark: this updates the official Conjur CLI's
// .conjurrc using a narrowly validated, fixed-argument vendor init command.
export function normalizeConjurSaaSAPIURL(input: string): string | null {
  if (input.length > 2048 || input.trim() !== input) return null;
  const match = /^https:\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.secretsmgr\.cyberark\.cloud)(?:\/(?:api)?)?$/.exec(input);
  return match ? `https://${match[1]}/api` : null;
}

type Props = Pick<SignInContext, 'status' | 'tool' | 'ready' | 'onToolsChanged' | 'invalidateSession'>;

export function ConjurBackendConnection(props: Props) {
  // Remount on a new vendor capability snapshot: no previous tenant state,
  // confirmation or in-flight response may be reused across tool changes.
  const { ready, tool } = props;
  const setupRequired = tool.credentialLogin?.method === 'conjur-password'
    ? tool.credentialLogin.setupRequired
    : undefined;
  const contextKey = JSON.stringify([ready, tool.packId, tool.toolId, tool.packVersion,
    tool.status, tool.version, tool.credentialLogin?.method, setupRequired]);
  return <ConjurBackendConnectionForm key={contextKey} {...props} />;
}

function ConjurBackendConnectionForm({ status, tool, ready, onToolsChanged, invalidateSession }: Props) {
  const [connection, setConnection] = useState<VendorConnection | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [editing, setEditing] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [readRevision, setReadRevision] = useState(0);
  const saveInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    void getVendorConnection(controller.signal).then((current) => {
      if (controller.signal.aborted) return;
      setLoadError(false);
      setConnection(current);
      setEditing(current.environment === 'unconfigured' && current.configurable);
      setEndpoint(current.environment === 'saas' ? current.applianceUrl : '');
    }).catch(() => {
      if (controller.signal.aborted) return;
      setConnection(null);
      setEditing(false);
      setEndpoint('');
      setLoadError(true);
    });
    return () => controller.abort();
  }, [ready, tool.packId, tool.toolId, tool.packVersion, readRevision]);

  if (!ready) return null;
  const existingURL = connection?.environment === 'saas' ? connection.applianceUrl : '';
  const normalizedURL = normalizeConjurSaaSAPIURL(endpoint);
  const replacing = existingURL !== '';
  const canSave = connection?.configurable === true && normalizedURL !== null &&
    normalizedURL !== existingURL && (!replacing || confirmed) && !saving;
  const save = async () => {
    if (!canSave || normalizedURL === null || !connection || saveInFlightRef.current) return;
    saveInFlightRef.current = true;
    setSaving(true);
    setSaveError(null);
    setSaved(false);
    // A timed-out vendor init could still have changed the active target.
    // Even on an error the previous whoami proof is no longer authoritative.
    invalidateSession?.();
    try {
      await configureCredentialConnection(status.csrfToken, {
        packId: tool.packId,
        toolId: tool.toolId,
        environment: 'saas',
        applianceUrl: normalizedURL,
        authnType: 'cloud',
        account: 'conjur',
        ...(replacing ? { expectedApplianceUrl: existingURL } : {}),
      });
      // Do not claim success from the init process alone: reconcile effective
      // vendor configuration and invalidate stale session evidence first.
      if (!mountedRef.current) return;
      const updated = await getVendorConnection();
      if (!mountedRef.current) return;
      if (updated.environment !== 'saas' || updated.applianceUrl !== normalizedURL) {
        // The vendor configuration is authoritative even when it differs from
        // the attempted write. Never leave the old confirmation actionable.
        setConnection(updated);
        setEndpoint(updated.environment === 'saas' ? updated.applianceUrl : '');
        setEditing(false);
        setConfirmed(false);
        setSaveError('The CLI did not report the requested endpoint. Inspect the official Conjur configuration.');
        onToolsChanged?.();
        return;
      }
      setConnection(updated);
      setEndpoint(updated.applianceUrl);
      setEditing(false);
      setConfirmed(false);
      setSaved(true);
      onToolsChanged?.();
    } catch (error) {
      // A request can time out after vendor init committed its configuration.
      // Hide previously read endpoint/approval evidence until an authoritative
      // reread; never let the operator retry against an assumed old target.
      if (mountedRef.current) {
        setSaveError(normalizeError(error).detail.message);
        setConnection(null);
        setEditing(false);
        setEndpoint('');
        setConfirmed(false);
        setLoadError(true);
      }
    } finally {
      saveInFlightRef.current = false;
      if (mountedRef.current) setSaving(false);
    }
  };

  return (
    <section className="credential-login-form" aria-label="Conjur API backend configuration">
      <div className="credential-login-heading">
        <div>
          <p className="status-label">CLI backend configuration</p>
          <h4>Conjur API connection</h4>
        </div>
        <span className="safety-chip">Vendor-managed</span>
      </div>
      <p className="credential-login-help">
        This is the API server used by the official Conjur CLI, not your CyberArk Identity login webpage.
        For a SaaS tenant, use <code>https://companyname.secretsmgr.cyberark.cloud</code>.
        Your CLI writes its connection settings to its normal configuration file.
      </p>
      {connection && (
        <div className="auth-tool-meta">
          <p>Current API endpoint: <strong>{connection.applianceUrl || 'Not configured'}</strong></p>
          <p>Environment: {connection.environment} · Account: {connection.account || 'Not configured'}</p>
        </div>
      )}
      {loadError && (
        <div className="credential-login-error" role="alert">
          <p>Unable to read the current vendor configuration. The active endpoint is unverified; review Diagnostics before retrying a change.</p>
          {saveError && <p>{saveError}</p>}
          <button type="button" className="secondary-button" disabled={saving}
            onClick={() => {
              invalidateSession?.();
              setLoadError(false);
              setSaveError(null);
              setReadRevision((previous) => previous + 1);
            }}>Retry reading CLI configuration</button>
        </div>
      )}
      {connection?.configurable === false && (
        <p className="credential-login-help">
          This configuration cannot be changed through the SaaS wizard. Existing self-hosted,
          read-only, or externally overridden vendor settings must be managed through the official CLI.
        </p>
      )}
      {saved && <p role="status">Conjur API endpoint saved and verified. Sign in again and check the session before running tasks.</p>}
      {!loadError && saveError && <p className="credential-login-error" role="alert">{saveError}</p>}
      {connection?.configurable && !editing && (
        <button type="button" className="secondary-button" onClick={() => { setEditing(true); setSaved(false); setSaveError(null); }}>
          Change API endpoint
        </button>
      )}
      {connection?.configurable && editing && (
        <form className="credential-login-fields" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <label className="field">
            <span>Secrets Manager API URL</span>
            <input type="url" name="conjur-saas-api-url" value={endpoint}
              placeholder="https://companyname.secretsmgr.cyberark.cloud" maxLength={2048}
              autoComplete="off" spellCheck={false} disabled={saving}
              aria-invalid={endpoint.length > 0 && normalizedURL === null}
              onChange={(event) => { setEndpoint(event.target.value); setConfirmed(false); setSaveError(null); }} required />
          </label>
          {endpoint && normalizedURL === null && (
            <p className="credential-login-help">Enter a direct HTTPS tenant API address ending in .secretsmgr.cyberark.cloud, without credentials, ports, or query strings.</p>
          )}
          {replacing && (
            <label className="field">
              <input type="checkbox" checked={confirmed} disabled={saving}
                onChange={(event) => setConfirmed(event.target.checked)} />
              <span>I understand that this will replace the existing vendor CLI connection. I will sign in again to verify the new tenant.</span>
            </label>
          )}
          <div className="credential-login-actions">
            <button type="submit" disabled={!canSave}>{saving ? 'Configuring API endpoint…' : replacing ? 'Replace CLI API endpoint' : 'Configure CLI API endpoint'}</button>
            {replacing && <button type="button" className="secondary-button" disabled={saving}
              onClick={() => { setEditing(false); setEndpoint(existingURL); setConfirmed(false); setSaveError(null); }}>Cancel</button>}
          </div>
        </form>
      )}
    </section>
  );
}
