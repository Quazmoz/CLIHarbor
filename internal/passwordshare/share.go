// Package passwordshare owns the opt-in, single-password LAN receiver. It has
// no access to packs, execution, vendor credentials, run history or persistence.
package passwordshare

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"log"
	"math/big"
	"net"
	"net/http"
	"net/http/httptrace"
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
	"unicode"
	"unicode/utf8"
)

const TTL = 5 * time.Minute

// MaxPasswordBytes fits a 4096-bit RSA PEM key plus a three-certificate chain
// (about 10 KiB) or a cloud service-account JSON key (about 2.5 KiB). JSON
// escaping at most doubles it, which stays inside the local 64 KiB body cap.
const MaxPasswordBytes = 16 << 10

var (
	ErrInvalid     = errors.New("invalid password-sharing request")
	ErrUnavailable = errors.New("password sharing is unavailable")
	ErrBusy        = errors.New("a password-sharing operation is already active")
	ErrGone        = errors.New("this invitation is no longer available")
	ErrUnconfirmed = errors.New("delivery is unconfirmed; check with the recipient before sending again")
	// Both refusals happen before a connection exists, so no password bytes left.
	ErrUnreachable = errors.New("could not connect securely to the recipient; nothing was sent")
	ErrMismatch    = errors.New("the receiver did not match the invitation; nothing was sent")
)

// Temporary app certificates tolerate this much clock difference between the two
// computers; the receiver's own deadline and listener still bound the transfer.
const clockSkew = time.Hour

type Status struct {
	State            string     `json:"state"`
	Addresses        []string   `json:"addresses"`
	BrowserAvailable bool       `json:"browserAvailable"`
	ID               string     `json:"id,omitempty"`
	Mode             string     `json:"mode,omitempty"`
	Origin           string     `json:"origin,omitempty"`
	Fingerprint      string     `json:"fingerprint,omitempty"`
	ExpiresAt        *time.Time `json:"expiresAt,omitempty"`
}

type Invitation struct {
	Status Status `json:"status"`
	URL    string `json:"invitation"`
}

// Service deliberately holds at most one invitation and one 16 KiB value.
// A timer erases the application buffer even when the local UI is closed.
type Service struct {
	mu                                   sync.Mutex
	sendMu                               sync.Mutex
	certificate                          *tls.Certificate
	addresses                            func() []string
	allowLoopback                        bool // set only by same-package hermetic tests
	now                                  func() time.Time
	ttl                                  time.Duration
	state, id, mode, origin, fingerprint string
	tokenHash                            [32]byte
	expires                              time.Time
	password                             []byte
	timer                                *time.Timer
	server                               *http.Server
	listener                             net.Listener
	closed                               bool
	sendCancel                           context.CancelFunc
}

func New(certFile, keyFile string) (*Service, error) {
	s := &Service{addresses: localAddresses, now: time.Now, ttl: TTL, state: "idle"}
	if (certFile == "") != (keyFile == "") {
		return nil, ErrInvalid
	}
	if certFile != "" {
		certPEM, err := readTLSFile(certFile)
		if err != nil {
			return nil, ErrUnavailable
		}
		defer clear(certPEM)
		keyPEM, err := readTLSFile(keyFile)
		if err != nil {
			return nil, ErrUnavailable
		}
		defer clear(keyPEM)
		cert, err := tls.X509KeyPair(certPEM, keyPEM)
		if err != nil || len(cert.Certificate) == 0 {
			return nil, ErrUnavailable
		}
		cert.Leaf, err = x509.ParseCertificate(cert.Certificate[0])
		if err != nil {
			return nil, ErrUnavailable
		}
		s.certificate = &cert
	}
	return s, nil
}

func readTLSFile(path string) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Size() > 1<<20 {
		return nil, ErrInvalid
	}
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil || !os.SameFile(before, after) {
		return nil, ErrInvalid
	}
	data, err := io.ReadAll(io.LimitReader(f, (1<<20)+1))
	if err != nil || len(data) > 1<<20 {
		clear(data)
		return nil, ErrInvalid
	}
	return data, nil
}

func localAddresses() []string {
	result := []string{}
	interfaces, _ := net.Interfaces()
	for _, iface := range interfaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := iface.Addrs()
		for _, addr := range addrs {
			prefix, err := netip.ParsePrefix(addr.String())
			if err == nil && prefix.Addr().Is4() && prefix.Addr().IsPrivate() {
				result = append(result, prefix.Addr().String())
			}
		}
	}
	slices.Sort(result)
	return slices.Compact(result)
}

func (s *Service) permittedIP(address string) bool {
	ip, err := netip.ParseAddr(address)
	return err == nil && ip.Is4() && (ip.IsPrivate() || s.allowLoopback && ip.IsLoopback())
}

func (s *Service) statusLocked() Status {
	status := Status{State: s.state, Addresses: s.addresses(), BrowserAvailable: s.certificate != nil,
		ID: s.id, Mode: s.mode, Origin: s.origin, Fingerprint: s.fingerprint}
	if !s.expires.IsZero() {
		t := s.expires
		status.ExpiresAt = &t
	}
	return status
}

func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	return s.statusLocked()
}

func (s *Service) expireLocked() {
	if (s.state == "waiting" || s.state == "received") && !s.now().Before(s.expires) {
		s.finishLocked("expired")
	}
}

func (s *Service) finishLocked(state string) {
	clear(s.password)
	s.password = nil
	s.tokenHash = [32]byte{}
	s.state = state
	if s.timer != nil {
		s.timer.Stop()
		s.timer = nil
	}
	if s.server != nil {
		_ = s.server.Close()
		s.server = nil
	}
	if s.listener != nil {
		_ = s.listener.Close()
		s.listener = nil
	}
}

func randomID(size int) (string, error) {
	data := make([]byte, size)
	if _, err := rand.Read(data); err != nil {
		return "", ErrUnavailable
	}
	return base64.RawURLEncoding.EncodeToString(data), nil
}

func (s *Service) Create(address, mode string) (Invitation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	if s.closed {
		return Invitation{}, ErrUnavailable
	}
	if s.state == "waiting" || s.state == "received" {
		return Invitation{}, ErrBusy
	}
	if !s.permittedIP(address) || !slices.Contains(s.addresses(), address) || (mode != "app" && mode != "browser") {
		return Invitation{}, ErrInvalid
	}
	var cert tls.Certificate
	var err error
	if mode == "browser" {
		if s.certificate == nil {
			return Invitation{}, ErrUnavailable
		}
		cert = *s.certificate
		if err := cert.Leaf.VerifyHostname(address); err != nil || s.now().Before(cert.Leaf.NotBefore) || !s.now().Add(s.ttl).Before(cert.Leaf.NotAfter) {
			return Invitation{}, ErrUnavailable
		}
	} else {
		cert, err = temporaryCertificate(address, s.now())
		if err != nil {
			return Invitation{}, ErrUnavailable
		}
	}
	id, err := randomID(16)
	if err != nil {
		return Invitation{}, err
	}
	token, err := randomID(32)
	if err != nil {
		return Invitation{}, err
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort(address, "0"))
	if err != nil {
		return Invitation{}, ErrUnavailable
	}
	s.state, s.id, s.mode = "waiting", id, mode
	// Compare the deadline on the wall clock: Go's monotonic clock pauses during
	// macOS/Linux suspend, which would otherwise extend an invitation after sleep.
	// The monotonic timer below still bounds a backwards wall-clock change.
	s.expires = s.now().Add(s.ttl).Round(0)
	origin := "https://" + listener.Addr().String()
	s.origin = origin
	s.fingerprint = fingerprint(cert.Leaf)
	s.tokenHash = sha256.Sum256([]byte(token))
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.remote(id, origin, mode, w, r) }), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 5 * time.Second,
		MaxHeaderBytes: 4096, ErrorLog: log.New(io.Discard, "", 0)}
	s.server, s.listener = server, listener
	// Runtime timers pause during suspend, so one ttl-long timer would keep the
	// buffer and listener alive long after a laptop wakes. Re-check the wall-clock
	// deadline every ttl/60 (5 seconds by default); the monotonic elapsed time
	// still bounds a backwards wall-clock change.
	started := time.Now()
	var expire func()
	expire = func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.id != id || (s.state != "waiting" && s.state != "received") {
			return
		}
		if left := s.expires.Sub(s.now()); left > 0 && time.Since(started) < s.ttl {
			s.timer = time.AfterFunc(min(left, s.ttl/60), expire)
			return
		}
		s.finishLocked("expired")
	}
	s.timer = time.AfterFunc(s.ttl/60, expire)
	go func() {
		err := server.Serve(tls.NewListener(&boundedListener{Listener: listener, slots: make(chan struct{}, 8)},
			&tls.Config{MinVersion: tls.VersionTLS13, Certificates: []tls.Certificate{cert}, NextProtos: []string{"http/1.1"}}))
		if err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.id == id && s.state == "waiting" {
				s.finishLocked("unavailable")
			}
		}
	}()
	fragment := url.Values{"v": {"1"}, "token": {token}, "pin": {s.fingerprint}, "mode": {mode}}
	return Invitation{Status: s.statusLocked(), URL: s.origin + "/#" + fragment.Encode()}, nil
}

func (s *Service) Cancel(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	if id == "" || id != s.id || (s.state != "waiting" && s.state != "received") {
		return ErrGone
	}
	s.finishLocked("cancelled")
	return nil
}

// Take is intentionally one-use. Losing its HTTP response is not permission to
// replay a reveal: the sender and recipient must arrange another invitation.
func (s *Service) Take(id string) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.expireLocked()
	if s.closed || id == "" || s.id != id || s.state != "received" {
		return nil, ErrGone
	}
	password := bytes.Clone(s.password)
	s.finishLocked("revealed")
	return password, nil
}

func (s *Service) Close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	if s.sendCancel != nil {
		s.sendCancel()
	}
	s.finishLocked("closed")
}

// normalizePassword rewrites CRLF to LF in place, so no second copy of the secret
// exists, then accepts 1-16 KiB of UTF-8 whose only control characters are LF
// and tab. A lone CR, any other control and every Cf character are refused.
func normalizePassword(data []byte) ([]byte, bool) {
	out := data[:0]
	for i, b := range data {
		if b != '\r' || i+1 == len(data) || data[i+1] != '\n' {
			out = append(out, b)
		}
	}
	if len(out) == 0 || len(out) > MaxPasswordBytes || !utf8.Valid(out) {
		return out, false
	}
	return out, !bytes.ContainsFunc(out, func(r rune) bool {
		return r != '\n' && r != '\t' && (unicode.IsControl(r) || unicode.In(r, unicode.Cf))
	})
}

func fingerprint(cert *x509.Certificate) string {
	hash := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
	return hex.EncodeToString(hash[:])
}

func temporaryCertificate(address string, now time.Time) (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
	if err != nil {
		return tls.Certificate{}, err
	}
	template := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "CLIHarbor temporary password receiver"},
		NotBefore: now.Add(-clockSkew), NotAfter: now.Add(TTL + clockSkew),
		IPAddresses: []net.IP{net.ParseIP(address)}, KeyUsage: x509.KeyUsageDigitalSignature,
		ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	leaf, err := x509.ParseCertificate(der)
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key, Leaf: leaf}, err
}

// ParseInvitation accepts only the fixed LAN protocol, never a proxy URL,
// hostname, redirect destination, custom path, or loopback command API.
func (s *Service) ParseInvitation(raw string) (*url.URL, string, string, error) {
	if len(raw) > 1024 {
		return nil, "", "", ErrInvalid
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Opaque != "" || u.RawQuery != "" || u.ForceQuery || u.Path != "/" || u.RawPath != "" || !s.permittedIP(u.Hostname()) {
		return nil, "", "", ErrInvalid
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || port < 1 || port > 65535 || u.Host != net.JoinHostPort(u.Hostname(), strconv.Itoa(port)) {
		return nil, "", "", ErrInvalid
	}
	fields, err := url.ParseQuery(u.Fragment)
	if err != nil || len(fields) != 4 {
		return nil, "", "", ErrInvalid
	}
	for _, values := range fields {
		if len(values) != 1 {
			return nil, "", "", ErrInvalid
		}
	}
	if fields.Get("v") != "1" || (fields.Get("mode") != "app" && fields.Get("mode") != "browser") {
		return nil, "", "", ErrInvalid
	}
	token, err := base64.RawURLEncoding.DecodeString(fields.Get("token"))
	if err != nil || len(token) != 32 || base64.RawURLEncoding.EncodeToString(token) != fields.Get("token") {
		return nil, "", "", ErrInvalid
	}
	pin, err := hex.DecodeString(fields.Get("pin"))
	if err != nil || len(pin) != 32 || hex.EncodeToString(pin) != fields.Get("pin") {
		return nil, "", "", ErrInvalid
	}
	u.Fragment = ""
	u.RawFragment = ""
	return u, fields.Get("token"), fields.Get("pin"), nil
}

func (s *Service) Send(ctx context.Context, invitation string, password []byte) error {
	if !s.sendMu.TryLock() {
		return ErrBusy
	}
	defer s.sendMu.Unlock()
	u, token, pin, err := s.ParseInvitation(invitation)
	password, ok := normalizePassword(password)
	if err != nil || !ok {
		return ErrInvalid
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		cancel()
		return ErrUnavailable
	}
	s.sendCancel = cancel
	s.mu.Unlock()
	defer func() { cancel(); s.mu.Lock(); s.sendCancel = nil; s.mu.Unlock() }()
	// Certificate pinning replaces PKI only for an explicitly supplied invitation.
	// VerifyConnection always checks the exact key, target IP and validity period;
	// there is no unverified-TLS or HTTP fallback.
	var connected, mismatched atomic.Bool
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, MaxResponseHeaderBytes: 4096,
		TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 5 * time.Second,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, // verified below
			VerifyConnection: func(state tls.ConnectionState) error {
				if len(state.PeerCertificates) == 0 {
					mismatched.Store(true)
					return ErrMismatch
				}
				cert := state.PeerCertificates[0]
				actual := fingerprint(cert)
				if subtle.ConstantTimeCompare([]byte(actual), []byte(pin)) != 1 {
					mismatched.Store(true)
					return ErrMismatch
				}
				roots := x509.NewCertPool()
				roots.AddCert(cert)
				if _, err := cert.Verify(x509.VerifyOptions{Roots: roots, DNSName: u.Hostname(), CurrentTime: s.now(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}); err != nil {
					mismatched.Store(true)
					return ErrMismatch
				}
				return nil
			}}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	u.Path = "/deliver"
	// GotConn fires only after TCP and the verified TLS handshake succeed. Before
	// it, the request was never written, so the failure is definitive.
	ctx = httptrace.WithClientTrace(ctx, &httptrace.ClientTrace{GotConn: func(httptrace.GotConnInfo) { connected.Store(true) }})
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(password))
	if err != nil {
		return ErrInvalid
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "text/plain; charset=utf-8")
	response, err := client.Do(request)
	if err != nil {
		switch {
		case connected.Load():
			return ErrUnconfirmed
		case mismatched.Load():
			return ErrMismatch
		}
		return ErrUnreachable
	}
	defer response.Body.Close()
	// The pinned receiver's refusals are definitive: nothing was stored.
	switch response.StatusCode {
	case http.StatusNoContent:
		return nil
	case http.StatusForbidden:
		return ErrGone
	case http.StatusBadRequest:
		return ErrInvalid
	}
	return ErrUnconfirmed
}

// Bound open TLS connections, including clients that never finish a handshake.
type boundedListener struct {
	net.Listener
	slots chan struct{}
}
type boundedConn struct {
	net.Conn
	release func()
	once    sync.Once
}

func (c *boundedConn) Close() error { err := c.Conn.Close(); c.once.Do(c.release); return err }
func (l *boundedListener) Accept() (net.Conn, error) {
	for {
		conn, err := l.Listener.Accept()
		if err != nil {
			return nil, err
		}
		select {
		case l.slots <- struct{}{}:
			return &boundedConn{Conn: conn, release: func() { <-l.slots }}, nil
		default:
			_ = conn.Close()
		}
	}
}
