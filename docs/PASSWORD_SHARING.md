# One-time LAN password sharing

This explicitly requested feature transports one password transiently. It adds
no credential vault or cloud relay. The command/authentication server stays on
loopback. A separate TLS 1.3 receiver opens only when the local operator creates
an invitation, on one selected RFC 1918 IPv4 interface. It expires in five minutes.

## Before you start

- Both computers must be on the same local network and able to reach a private
  IPv4 address (10.x, 172.16–31.x or 192.168.x). A firewall, VPN or
  client-isolated Wi-Fi can block the connection; CLIHarbor does not change them.
- Arrange a trusted way to talk to the other person, such as a phone call or
  being in the same room. You will read the receiving address (and, between two
  CLIHarbor apps, the fingerprint) to each other over it.
- The invitation lasts five minutes and accepts one value. Have the value ready
  before the recipient creates it.
- What you can send: one password, or one multi-line secret such as a PEM private
  key, a certificate or certificate chain, an SSH private key or a JSON
  service-account key file. Limit: 16,384 bytes (16 KiB).

## Between two CLIHarbor apps

Recipient:

1. Open **Password sharing** → **Receive a password**.
2. Choose **Your LAN address** (the address the sender can reach) and
   **From their CLIHarbor**, then **Create five-minute invitation**.
3. **Copy invitation** and send it to the sender over a trusted channel. Anyone
   holding it can submit a value, so treat it as a secret.
4. Read the sender the **Receiving address** and **Certificate fingerprint**.
5. Wait for "A password was received." Confirm with the sender that it was them,
   then **Reveal received password once** (see [Receiving](#receiving-the-value)).

Sender:

1. Open **Password sharing** → **Send a password**.
2. Paste the invitation and choose **Check receiving address**.
3. Compare the address and fingerprint with what the recipient reads you. Both
   must match exactly; if not, stop and ask for a new invitation.
4. Tick the confirmation box. For a key, certificate or JSON key file, tick
   **Multi-line value** (see [below](#sending-a-key-certificate-or-json-key-file)).
5. Enter or paste the value and choose **Send password once**. The value and
   invitation clear from the page as soon as you send.

The sender's CLIHarbor checks the receiver's exact temporary SHA-256 public-key
fingerprint, IP subject alternative name and certificate validity. The temporary
ECDSA certificate and key exist only in the recipient's memory. No trust store is
changed.

## From a web browser (sender without CLIHarbor)

The recipient's CLIHarbor must be started with an operator-provided certificate
and key:

```text
cliharbor serve --share-tls-cert receiver-cert.pem --share-tls-key receiver-key.pem
```

The operator owns these files; CLIHarbor reads but does not copy or persist them.
The certificate must include the receiving IP address in its IP subject
alternative names, stay valid for the invitation's five minutes, and already be
trusted on the sender's device through the organization's approved process.
Without both flags, **From a web browser** stays disabled. An IP certificate may
need renewing when DHCP changes the address.

Recipient: follow the steps above, but choose **From a web browser**, send the
invitation link, and read the sender only the **Receiving address** (a browser
cannot show the fingerprint).

Sender:

1. Open the whole link in a browser on the same network. The page removes the
   secret part from the address bar straight away. If you reload, open the
   original link again.
2. Check that the **Receiving computer** address matches what the recipient reads
   you, and that the browser shows a secure connection. **If the browser shows a
   certificate warning, stop.** Do not bypass it; tell the recipient.
3. For a key, certificate or JSON key file, tick **Multi-line value**.
4. Enter or paste the value, tick the confirmation box and choose
   **Send password once**.

The sender page has no CLIHarbor command, authentication, session or reveal
endpoints.

## Sending a key, certificate or JSON key file

- Tick **Multi-line value** *before* pasting. The default masked field is a
  password box, and browsers remove line breaks from anything pasted into one.
  Both senders refuse PEM text (`-----BEGIN …-----`) pasted into the masked field
  for that reason.
- The multi-line field is **not masked**: its contents are visible on screen.
  Check that nobody can see your screen, and that screen sharing or recording is
  off. Switching between the two fields clears what you typed.
- Line breaks and tabs are kept. Windows line endings (CRLF) arrive as LF. Other
  control characters and invisible formatting characters are refused.
- Send one file per invitation. To send a key and its certificate, either paste
  them together in one value (up to 16 KiB) or use two invitations.
- An older CLIHarbor receiver accepts only single-line passwords. It refuses a
  multi-line value without storing it; the recipient needs to update first.
- A JSON key file can also be pasted into the masked field, because its line
  breaks are only formatting, but the multi-line field keeps it exactly as written.

## Receiving the value

**Reveal received password once** shows the value one time only; it cannot be
revealed again. A single-line value appears in a text field and a multi-line value
in a read-only text area. Use **Copy received password** to copy it, then paste
it where it is needed. The value clears from the page after one minute, when you
hide or leave the page, or when you choose **Hide and clear password**. If it was
revealed while the page was hidden, it is discarded; ask for a new transfer.

CLIHarbor never saves the value to a file or offers it as a download. If you need
it in a file (for example a private key), paste it into one yourself and set
permissions as your organization requires. Clear your clipboard afterwards;
clipboard managers can keep copies. Before relying on a key or certificate, check
it with your usual tools (for example that the key matches its certificate).

## What each message means

| Message | What happened | What to do |
| --- | --- | --- |
| Password delivered / Password sent | The recipient's computer stored the value. | The recipient confirms with you, then reveals it once. |
| Could not be reached securely. Nothing was sent. | No secure connection was made. | Check that the invitation is still waiting, both computers are on the same network, and no firewall, VPN or isolated Wi-Fi blocks it. Then send again. |
| The computer at this address is not the one in the invitation. Nothing was sent. | The receiver's key, address or certificate dates did not match. | Do not retry with this invitation. Confirm the address over a trusted channel, check both clocks, and ask for a new invitation. |
| This password invitation is no longer available | It expired, was cancelled or was already used. Nothing was stored. | Ask the recipient for a new invitation. |
| Did not accept this value, and nothing was stored | The receiver refused the value: too large, a disallowed character, or a multi-line value sent to an older CLIHarbor. | Fix the value, or ask the recipient to update. Paste the same invitation again while it is still waiting, or ask for a new one. |
| This looks like a key or certificate, and the masked field removed its line breaks | PEM text was pasted into the masked field. Nothing was sent. | Tick **Multi-line value** and paste it again. |
| Delivery was not confirmed / could not be confirmed | The connection was made but the answer was lost. The recipient **may already have it**. | Do not resend automatically. Ask the recipient what their page shows. "A password was received" means it arrived. If it still says waiting, nothing was stored and you can send again with the same invitation. |
| Browser certificate warning | The browser does not trust the receiver's certificate. | Stop. Do not bypass the warning. The recipient checks the certificate and its IP address. |

IPv6, DNS names, public-IP/internet delivery and third-party transfer clients are
outside this implementation. CLIHarbor never opens firewall rules, installs CAs
or bypasses policy.

## Security contract

- A random 256-bit invitation capability and receiver key fingerprint are in a
  URL fragment, excluded from HTTP request targets and server status metadata.
  The browser removes that fragment from its current history entry immediately.
  Treat invitations as secrets; anyone with one can submit, and possession does
  not prove the human sender's identity.
- Only one invitation and one UTF-8 value of 1–16,384 bytes may be retained. The
  value may be a single-line password or a multi-line secret such as a PEM private
  key, certificate chain, SSH key or JSON service-account file. LF and tab are the
  only control characters accepted; CRLF is normalized to LF in place (no second
  copy) by both sender and receiver, and a lone CR, every other control or Unicode
  format (Cf) character, invalid UTF-8 and empty values are refused. The receiver
  alone decides: invitations stay protocol `v=1`, and an older receiver answers a
  multi-line value with 400, which senders report as definitive (nothing stored).
  16 KiB fits a 4096-bit RSA PEM key with a three-certificate chain (about 10 KiB)
  or a cloud JSON key (about 2.5 KiB). The same limit applies in the Go receiver
  and sender, the LAN body reader, the browser sender page and the app UI. The app
  sends it inside JSON, where escaping at most doubles it (newline, tab, quote and
  backslash become two bytes), so it stays inside the unchanged 64 KiB local body cap.
  Multi-line entry is an explicit choice in both senders and is not masked; the
  UI says so. A multi-line reveal is shown in a read-only text area. The deadline clears the receiver buffer without requiring UI polling.
  Cancel, reveal and shutdown also clear it. The revealed UI value clears after
  one minute and on hiding/leaving the page. The original deadline still applies
  if the password arrives just before expiry. The deadline is compared on the
  wall clock, because Go's monotonic clock pauses during macOS/Linux suspend. The
  receiver re-checks it every few seconds (TTL/60), so after a laptop wakes the
  buffer and listener close within seconds without UI polling; elapsed monotonic
  time still bounds a backwards wall-clock change.
- The LAN listener stops accepting connections as soon as one password is stored;
  the in-flight response still completes.
- Local create, inspect, send, cancel and reveal are session/Origin/CSRF-protected
  POSTs. Reveal consumes the value once. A lost acknowledgement can mean a send
  or reveal already happened; no mutation is automatically retried. A refusal
  (403/400) from the pinned or trusted receiver is definitive — nothing was
  stored — and is reported as such rather than as unconfirmed. So is an app send
  that fails before a verified TLS connection exists: an unreachable address
  (firewall, expired or already-used invitation) reports that nothing was sent,
  and a key, IP or validity mismatch reports that the receiver did not match the
  invitation. Only failures after the connection is established are unconfirmed.
- The LAN receiver has fixed static paths and one `POST /deliver`, exact Host and
  Origin validation, no cookies/CORS, no plaintext fallback, strict body/header
  limits, eight concurrent TLS connections and finite handshake/read/idle timeouts.
  Authentication and consumption are checked again atomically after reading the
  bounded body. Old requests cannot write into a new invitation.
- App sending accepts only literal private IPv4 HTTPS targets and `/deliver`,
  verifies the pinned key, certificate lifetime and IP SAN, and disables proxies
  and redirects. Temporary receiver certificates are valid one hour either side
  of the invitation so ordinary clock differences between two computers do not
  break transfers; the exact ephemeral-key pin and five-minute receiver deadline
  are what bound the transfer. There is no arbitrary browser-chosen HTTP method or proxy API.
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
