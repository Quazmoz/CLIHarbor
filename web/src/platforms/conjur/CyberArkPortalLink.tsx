import { useState } from 'react';

// This is a browser-only shortcut to the organization's Identity portal, NOT
// a Conjur API endpoint or a replacement for the vendor-owned CLI login.
const storageKey = 'cliharbor.cyberark.identity-portal-url';

export function normalizeCyberArkIdentityPortalURL(value: string): string | null {
  if (value.length > 2048 || value.trim() !== value || !value.startsWith('https://')) return null;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== 'https:' ||
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.port !== '' ||
      parsed.pathname !== '/' ||
      parsed.search !== '' ||
      parsed.hash !== '' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cyberark\.cloud$/.test(parsed.hostname)
    ) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function readSavedPortalURL(): string {
  try {
    return normalizeCyberArkIdentityPortalURL(window.localStorage.getItem(storageKey) ?? '') ?? '';
  } catch {
    return '';
  }
}

export function CyberArkPortalLink() {
  const [savedURL, setSavedURL] = useState(readSavedPortalURL);
  const [portalURL, setPortalURL] = useState(savedURL);
  const [saveError, setSaveError] = useState(false);
  const validatedURL = normalizeCyberArkIdentityPortalURL(portalURL);

  const savePortal = () => {
    if (validatedURL === null) return;
    try {
      window.localStorage.setItem(storageKey, validatedURL);
    } catch {
      setSaveError(true);
      return;
    }
    setSaveError(false);
    setSavedURL(validatedURL);
    setPortalURL(validatedURL);
  };

  return (
    <section className="credential-login-form" aria-label="CyberArk Identity portal shortcut">
      <div className="credential-login-heading">
        <div>
          <p className="status-label">Optional browser shortcut</p>
          <h4>CyberArk Identity portal</h4>
        </div>
        <span className="safety-chip">User-configured</span>
      </div>
      <p className="credential-login-help" id="cyberark-portal-help">
        Enter your organization’s Identity portal address. For example, <code>companyname.cyberark.cloud</code>.
        This only opens the portal in a separate tab. Conjur SaaS uses a different
        <code> tenant.secretsmgr.cyberark.cloud</code> service endpoint; the official CLI login
        and Check session are still required for CLIHarbor access.
      </p>
      <div className="credential-login-fields">
        <label className="field">
          <span>CyberArk Identity login URL</span>
          <input
            name="cyberark-identity-portal-url"
            type="url"
            value={portalURL}
            maxLength={2048}
            placeholder="https://companyname.cyberark.cloud"
            autoComplete="off"
            spellCheck={false}
            aria-describedby="cyberark-portal-help"
            aria-invalid={portalURL.length > 0 && validatedURL === null}
            onChange={(event) => {
              setPortalURL(event.target.value);
              setSaveError(false);
            }}
          />
        </label>
      </div>
      {portalURL.length > 0 && validatedURL === null && (
        <p role="alert">Use only your organization’s HTTPS tenant address, such as https://companyname.cyberark.cloud, without a path or query.</p>
      )}
      {saveError && <p role="alert">Browser storage is unavailable. This address was not saved.</p>}
      <div className="credential-login-actions">
        <button type="button" className="secondary-button" onClick={savePortal}
          disabled={validatedURL === null || savedURL === validatedURL}>
          Save portal address
        </button>
        {validatedURL !== null && savedURL === validatedURL && (
          <a href={savedURL} target="_blank" rel="noopener noreferrer">
            Open CyberArk Identity portal
          </a>
        )}
      </div>
      <p className="credential-login-help">
        Only the portal address is saved in this browser’s local storage, never credentials.
        If CLIHarbor’s local origin changes, enter the address again.
      </p>
    </section>
  );
}
