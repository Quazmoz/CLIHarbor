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
	"net/netip"
	"net/url"
	"os"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

const TTL = 5 * time.Minute
const MaxPasswordBytes = 4096

var (
	ErrInvalid     = errors.New("invalid password-sharing request")
	ErrUnavailable = errors.New("password sharing is unavailable")
	ErrBusy        = errors.New("a password-sharing operation is already active")
	ErrGone        = errors.New("this invitation is no longer available")
	ErrUnconfirmed = errors.New("delivery is unconfirmed; check with the recipient before sending again")
)

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

// Service deliberately holds at most one invitation and one 4 KiB password.
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
		if err := cert.Leaf.VerifyHostname(address); err != nil || s.now().Before(cert.Leaf.NotBefore) || !s.now().Add(TTL).Before(cert.Leaf.NotAfter) {
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
	s.expires = s.now().Add(s.ttl)
	origin := "https://" + listener.Addr().String()
	s.origin = origin
	s.fingerprint = fingerprint(cert.Leaf)
	s.tokenHash = sha256.Sum256([]byte(token))
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { s.remote(id, origin, mode, w, r) }), ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 5 * time.Second,
		MaxHeaderBytes: 4096, ErrorLog: log.New(io.Discard, "", 0)}
	s.server, s.listener = server, listener
	s.timer = time.AfterFunc(s.ttl, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.id == id && (s.state == "waiting" || s.state == "received") {
			s.finishLocked("expired")
		}
	})
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

func validPassword(data []byte) bool {
	if len(data) == 0 || len(data) > MaxPasswordBytes || !utf8.Valid(data) {
		return false
	}
	return !strings.ContainsFunc(string(data), func(r rune) bool { return unicode.IsControl(r) || unicode.In(r, unicode.Cf) })
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
		NotBefore: now.Add(-time.Minute), NotAfter: now.Add(TTL + time.Minute),
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
	if err != nil || !validPassword(password) {
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
	transport := &http.Transport{Proxy: nil, DisableKeepAlives: true, MaxResponseHeaderBytes: 4096,
		TLSHandshakeTimeout: 5 * time.Second, ResponseHeaderTimeout: 5 * time.Second,
		TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, InsecureSkipVerify: true, // verified below
			VerifyConnection: func(state tls.ConnectionState) error {
				if len(state.PeerCertificates) == 0 {
					return ErrUnavailable
				}
				cert := state.PeerCertificates[0]
				actual := fingerprint(cert)
				if subtle.ConstantTimeCompare([]byte(actual), []byte(pin)) != 1 {
					return ErrUnavailable
				}
				roots := x509.NewCertPool()
				roots.AddCert(cert)
				_, err := cert.Verify(x509.VerifyOptions{Roots: roots, DNSName: u.Hostname(), CurrentTime: s.now(), KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}})
				return err
			}}}
	defer transport.CloseIdleConnections()
	client := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	u.Path = "/deliver"
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), bytes.NewReader(password))
	if err != nil {
		return ErrInvalid
	}
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Content-Type", "text/plain; charset=utf-8")
	response, err := client.Do(request)
	if err != nil {
		return ErrUnconfirmed
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusNoContent {
		return ErrUnconfirmed
	}
	return nil
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
