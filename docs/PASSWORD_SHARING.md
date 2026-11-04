# One-time LAN password sharing

This explicitly requested feature transports one password transiently. It adds
no credential vault or cloud relay. The command/authentication server stays on
loopback. A separate TLS 1.3 receiver opens only when the local operator creates
an invitation, on one selected RFC 1918 IPv4 interface. It expires in five minutes.

## Another CLIHarbor instance

Open **Password sharing** on both computers. The recipient selects a LAN address
and **CLIHarbor** as the sender type, creates an invitation, then shares it through
a trusted channel. The sender chooses **Send from CLIHarbor**, pastes the
invitation and checks the address/fingerprint with the recipient before entering
the password and approving the transfer. Temporary ECDSA certificate/key material
is generated in memory; the sender checks its exact SHA-256 public-key fingerprint,
IP subject alternative name and validity. No trust store is changed.

## Browser sender on the LAN

Start the receiving app with both `--share-tls-cert <PEM>` and
`--share-tls-key <PEM>`, then select **Web browser**. The operator owns
these files; CLIHarbor reads but does not copy or persist them. The certificate
must include the selected IP in its IP subject alternative names, stay valid
through the invitation lifetime, and already be trusted by the sender's device
through the approved organization trust process. Do not bypass certificate
warnings. Without certificate/key configuration browser invitations are disabled.

For a built executable, launch with your approved PEM files:

```text
cliharbor serve --share-tls-cert receiver-cert.pem --share-tls-key receiver-key.pem
```

The sender opens the invitation, confirms the address with the recipient and
submits one password. The sender page has no CLIHarbor command, authentication,
session or reveal endpoints. The recipient uses **Reveal received password once**
in their own authenticated local workspace. Clipboard copy is an explicit action.

An IP certificate may need to be renewed when DHCP changes the receiving address.
IPv6, DNS names, public-IP/internet delivery and third-party transfer clients are
outside this implementation. A firewall, VPN or client-isolated Wi-Fi may block
connections. CLIHarbor never opens firewall rules, installs CAs or bypasses policy.

## Security contract

- A random 256-bit invitation capability and receiver key fingerprint are in a
  URL fragment, excluded from HTTP request targets and server status metadata.
  The browser removes that fragment from its current history entry immediately.
  Treat invitations as secrets; anyone with one can submit, and possession does
  not prove the human sender's identity.
- Only one invitation and one single-line UTF-8 password (1–4,096 bytes) may be
  retained. The deadline clears the receiver buffer without requiring UI polling.
  Cancel, reveal and shutdown also clear it. The revealed UI value clears after
  one minute and on hiding/leaving the page. The original deadline still applies
  if the password arrives just before expiry.
- Local create, inspect, send, cancel and reveal are session/Origin/CSRF-protected
  POSTs. Reveal consumes the value once. A lost acknowledgement can mean a send
  or reveal already happened; no mutation is automatically retried.
- The LAN receiver has fixed static paths and one `POST /deliver`, exact Host and
  Origin validation, no cookies/CORS, no plaintext fallback, strict body/header
  limits, eight concurrent TLS connections and finite handshake/read/idle timeouts.
  Authentication and consumption are checked again atomically after reading the
  bounded body. Old requests cannot write into a new invitation.
- App sending accepts only literal private IPv4 HTTPS targets and `/deliver`,
  verifies the pinned key, certificate lifetime and IP SAN, and disables proxies
  and redirects. There is no arbitrary browser-chosen HTTP method or proxy API.
- Passwords/invitations do not enter argv, subprocesses, logs, runs, preferences,
  diagnostics or intentional disk storage. Buffer clearing is best effort:
  managed memory, OS swap, extensions, screenshots and clipboard managers may
  retain copies. Delivery/reveal limits do not erase recipient copies.
- A hostile LAN can deny service. Bounded resources and confidentiality are the
  design goals, not guaranteed availability during a flood. No automatic Conjur
  login or save follows a transfer; saving into Conjur is a separate approved action.

## Qualification

Go security tests exercise real TLS transfer, key/name/expiry/TLS-version refusal,
parallel submissions, strict invitation parsing, replay, expiry and cleanup.
Server tests cover the local session/Origin/CSRF and strict JSON boundary. React
tests cover explicit creation/consent/reveal, secret clearing and remount locks.
Browser and native Windows qualification are reported separately for each change.
Before beta/release: test two real devices, Windows networking/firewall/interface
selection and browser trust with an organization-approved IP certificate. Cross-
compilation and source merges alone do not qualify that environment. GitHub Actions
remain manual-only and require separate explicit authorization.

References: [Go TLS verification](https://pkg.go.dev/crypto/tls#Config),
[IP SAN checking](https://pkg.go.dev/crypto/x509#Certificate.VerifyHostname),
[URL fragments](https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment).
