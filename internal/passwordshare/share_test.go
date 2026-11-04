package passwordshare

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"io"
	"log"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func testService(t *testing.T, browser bool) *Service {
	t.Helper()
	s, err := New("", "")
	if err != nil {
		t.Fatal(err)
	}
	s.allowLoopback = true
	s.addresses = func() []string { return []string{"127.0.0.1"} }
	if browser {
		cert, err := temporaryCertificate("127.0.0.1", time.Now())
		if err != nil {
			t.Fatal(err)
		}
		s.certificate = &cert
	}
	t.Cleanup(s.Close)
	return s
}

func testInvitation(t *testing.T, s *Service, mode string) Invitation {
	t.Helper()
	invite, err := s.Create("127.0.0.1", mode)
	if err != nil {
		t.Fatal(err)
	}
	return invite
}

func browserClient(t *testing.T, s *Service) *http.Client {
	t.Helper()
	pool := x509.NewCertPool()
	pool.AddCert(s.certificate.Leaf)
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS13, RootCAs: pool}, DisableKeepAlives: true}
	t.Cleanup(transport.CloseIdleConnections)
	return &http.Client{Transport: transport, Timeout: 3 * time.Second}
}

func submit(t *testing.T, client *http.Client, invite Invitation, body []byte, origin string) *http.Response {
	t.Helper()
	u, _ := url.Parse(invite.URL)
	fields, _ := url.ParseQuery(u.Fragment)
	request, _ := http.NewRequest(http.MethodPost, invite.Status.Origin+"/deliver", bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+fields.Get("token"))
	request.Header.Set("Content-Type", "text/plain; charset=utf-8")
	if origin != "" {
		request.Header.Set("Origin", origin)
	}
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	return response
}

func TestAppTransferTLSOneUseAndNoStatusLeak(t *testing.T) {
	receiver, sender := testService(t, false), testService(t, false)
	invite := testInvitation(t, receiver, "app")
	const password = "transport-only-fixture"
	if err := sender.Send(t.Context(), invite.URL, []byte(password)); err != nil {
		t.Fatal(err)
	}
	status := receiver.Status()
	if status.State != "received" {
		t.Fatalf("state %s", status.State)
	}
	metadata, _ := json.Marshal(status)
	if strings.Contains(string(metadata), password) || strings.Contains(string(metadata), "token=") || strings.Contains(string(metadata), invite.URL) {
		t.Fatal("status leaked secret material")
	}
	if err := sender.Send(t.Context(), invite.URL, []byte("replacement")); !errors.Is(err, ErrUnconfirmed) {
		t.Fatalf("replay = %v", err)
	}
	receiver.mu.Lock()
	original := receiver.password
	receiver.mu.Unlock()
	got, err := receiver.Take(invite.Status.ID)
	if err != nil || string(got) != password {
		t.Fatal("transfer mismatch")
	}
	clear(got)
	if !bytes.Equal(original, make([]byte, len(original))) {
		t.Fatal("receiver buffer was not cleared")
	}
	if _, err := receiver.Take(invite.Status.ID); !errors.Is(err, ErrGone) {
		t.Fatal("reveal replay accepted")
	}
	if _, err := receiver.Create("127.0.0.1", "app"); err != nil {
		t.Fatal(err)
	}
	if err := receiver.Cancel(invite.Status.ID); !errors.Is(err, ErrGone) {
		t.Fatal("old cancellation changed a new invitation")
	}
}

func TestBrowserTLSFixedRoutesAndOrigin(t *testing.T) {
	s := testService(t, true)
	invite := testInvitation(t, s, "browser")
	client := browserClient(t, s)
	for _, path := range []string{"/", "/sender.js", "/sender.css"} {
		response, err := client.Get(invite.Status.Origin + path)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(response.Body)
		response.Body.Close()
		if response.StatusCode != 200 || strings.Contains(string(body), "token=") || response.Header.Get("Cache-Control") != "no-store" || response.Header.Get("Referrer-Policy") != "no-referrer" || !strings.Contains(response.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
			t.Fatalf("unsafe static route %s", path)
		}
	}
	for _, path := range []string{"/api/v1/runs", "/api/v1/status", "/api/v1/password-sharing/reveal", "/bootstrap", "/assets/index.js", "/?token=x", "/sender.js?token=x"} {
		response, err := client.Get(invite.Status.Origin + path)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 404 && response.StatusCode != 403 {
			t.Fatalf("remote app surface exposed: %s %d", path, response.StatusCode)
		}
	}
	response := submit(t, client, invite, []byte("fixture"), "https://attacker.invalid")
	response.Body.Close()
	if response.StatusCode != 403 || s.Status().State != "waiting" {
		t.Fatal("foreign origin accepted or consumed invitation")
	}
	for _, bad := range [][]byte{nil, bytes.Repeat([]byte("a"), 4097), {0xff}, []byte("line\nbreak"), []byte("invisible\u200bformat")} {
		response = submit(t, client, invite, bad, invite.Status.Origin)
		response.Body.Close()
		if response.StatusCode != 400 || s.Status().State != "waiting" {
			t.Fatal("invalid value accepted or consumed invitation")
		}
	}
	response = submit(t, client, invite, []byte("browser-fixture"), invite.Status.Origin)
	response.Body.Close()
	if response.StatusCode != 204 || s.Status().State != "received" {
		t.Fatal("browser transfer failed")
	}
}

func TestConcurrentSubmissionsConsumeExactlyOnce(t *testing.T) {
	s := testService(t, true)
	invite := testInvitation(t, s, "browser")
	client := browserClient(t, s)
	u, _ := url.Parse(invite.URL)
	fields, _ := url.ParseQuery(u.Fragment)
	var successes atomic.Int32
	var group sync.WaitGroup
	for range 20 {
		group.Go(func() {
			request, _ := http.NewRequest(http.MethodPost, invite.Status.Origin+"/deliver", strings.NewReader("race-fixture"))
			request.Header.Set("Authorization", "Bearer "+fields.Get("token"))
			request.Header.Set("Content-Type", "text/plain")
			response, err := client.Do(request)
			if err == nil {
				defer response.Body.Close()
				if response.StatusCode == 204 {
					successes.Add(1)
				}
			}
		})
	}
	group.Wait()
	if successes.Load() != 1 {
		t.Fatalf("accepted %d submissions", successes.Load())
	}
	got, err := s.Take(invite.Status.ID)
	defer clear(got)
	if err != nil || string(got) != "race-fixture" {
		t.Fatal("concurrent delivery changed value")
	}
}

func TestExpiryClearsBufferAndClosesReceiverWithoutUI(t *testing.T) {
	s := testService(t, false)
	s.ttl = 100 * time.Millisecond
	invite := testInvitation(t, s, "app")
	sender := testService(t, false)
	if err := sender.Send(t.Context(), invite.URL, []byte("expiry-fixture")); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	original := s.password
	s.mu.Unlock()
	deadline := time.Now().Add(2 * time.Second)
	for {
		s.mu.Lock()
		state := s.state
		s.mu.Unlock()
		if state == "expired" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("timer did not expire without status reads")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if !bytes.Equal(original, make([]byte, len(original))) {
		t.Fatal("expired password buffer remains")
	}
	if _, err := s.Take(invite.Status.ID); !errors.Is(err, ErrGone) {
		t.Fatal("expired reveal succeeded")
	}
}

func TestCancelAndShutdownEraseAndStop(t *testing.T) {
	for _, closeService := range []bool{false, true} {
		t.Run(map[bool]string{false: "cancel", true: "shutdown"}[closeService], func(t *testing.T) {
			s, sender := testService(t, false), testService(t, false)
			invite := testInvitation(t, s, "app")
			if _, err := s.Create("127.0.0.1", "app"); !errors.Is(err, ErrBusy) {
				t.Fatal("parallel invitation allowed")
			}
			if err := sender.Send(t.Context(), invite.URL, []byte("cleanup-fixture")); err != nil {
				t.Fatal(err)
			}
			s.mu.Lock()
			original := s.password
			s.mu.Unlock()
			if closeService {
				s.Close()
			} else if err := s.Cancel(invite.Status.ID); err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(original, make([]byte, len(original))) {
				t.Fatal("buffer not cleared")
			}
			if _, err := s.Take(invite.Status.ID); !errors.Is(err, ErrGone) {
				t.Fatal("closed/cancelled reveal accepted")
			}
		})
	}
}

func TestPinnedTLSRefusesWrongKeyNameExpiryAndDowngradeBeforeBody(t *testing.T) {
	for _, kind := range []string{"key", "name", "expired", "tls12"} {
		t.Run(kind, func(t *testing.T) {
			var calls atomic.Int32
			peer := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { calls.Add(1); w.WriteHeader(204) }))
			peer.Config.ErrorLog = log.New(io.Discard, "", 0)
			certIP, now := "127.0.0.1", time.Now()
			if kind == "name" {
				certIP = "192.168.1.2"
			}
			if kind == "expired" {
				now = now.Add(-time.Hour)
			}
			cert, err := temporaryCertificate(certIP, now)
			if err != nil {
				t.Fatal(err)
			}
			peer.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
			if kind == "tls12" {
				peer.TLS.MaxVersion = tls.VersionTLS12
			}
			peer.StartTLS()
			defer peer.Close()
			s := testService(t, false)
			token, _ := randomID(32)
			pin := fingerprint(cert.Leaf)
			if kind == "key" {
				pin = strings.Repeat("0", 64)
			}
			link := peer.URL + "/#" + url.Values{"v": {"1"}, "mode": {"app"}, "token": {token}, "pin": {pin}}.Encode()
			if err := s.Send(context.Background(), link, []byte("must-not-transmit")); !errors.Is(err, ErrUnconfirmed) {
				t.Fatalf("TLS refusal = %v", err)
			}
			if calls.Load() != 0 {
				t.Fatal("password HTTP body reached an unauthenticated TLS peer")
			}
		})
	}
}

func TestInvitationParserAndConfigurationFailClosed(t *testing.T) {
	s := testService(t, false)
	invite := testInvitation(t, s, "app")
	for _, bad := range []string{
		strings.Replace(invite.URL, "https:", "http:", 1),
		strings.Replace(invite.URL, "127.0.0.1", "8.8.8.8", 1),
		strings.Replace(invite.URL, "127.0.0.1", "169.254.169.254", 1),
		strings.Replace(invite.URL, "127.0.0.1", "localhost", 1),
		strings.Replace(invite.URL, "/#", "/api/v1/runs#", 1),
		strings.Replace(invite.URL, "/#", "/?token=leak#", 1),
		invite.URL + "&v=1", invite.URL + "&extra=x", invite.URL + "%00", strings.Replace(invite.URL, "https://", "https://user@", 1),
	} {
		if _, _, _, err := s.ParseInvitation(bad); !errors.Is(err, ErrInvalid) {
			t.Fatal("unsafe invitation accepted")
		}
	}
	production, _ := New("", "")
	defer production.Close()
	if _, _, _, err := production.ParseInvitation(invite.URL); !errors.Is(err, ErrInvalid) {
		t.Fatal("production accepted loopback destination")
	}
	if _, err := production.Create("0.0.0.0", "app"); !errors.Is(err, ErrInvalid) {
		t.Fatal("wildcard listener accepted")
	}
	if _, err := production.Create("192.168.3.4", "browser"); err == nil {
		t.Fatal("unconfigured browser receiver accepted")
	}
	if _, err := New("certificate-only", ""); !errors.Is(err, ErrInvalid) {
		t.Fatal("partial certificate configuration accepted")
	}
}

func TestOperatorCertificateLoadingIsBoundedAndReadOnly(t *testing.T) {
	cert, err := temporaryCertificate("127.0.0.1", time.Now())
	if err != nil {
		t.Fatal(err)
	}
	key, err := x509.MarshalPKCS8PrivateKey(cert.PrivateKey)
	if err != nil {
		t.Fatal(err)
	}
	defer clear(key)
	directory := t.TempDir()
	certPath, keyPath := filepath.Join(directory, "certificate.pem"), filepath.Join(directory, "private-key.pem")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert.Certificate[0]}), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: key}), 0600); err != nil {
		t.Fatal(err)
	}
	service, err := New(certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}
	service.Close()
	entries, _ := os.ReadDir(directory)
	if len(entries) != 2 {
		t.Fatal("certificate setup persisted new files")
	}
	if _, err := New(keyPath, certPath); !errors.Is(err, ErrUnavailable) {
		t.Fatal("invalid certificate/key accepted")
	}
	if _, err := New(directory, keyPath); !errors.Is(err, ErrUnavailable) {
		t.Fatal("directory certificate accepted")
	}
	if err := os.WriteFile(certPath, bytes.Repeat([]byte("x"), (1<<20)+1), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := New(certPath, keyPath); !errors.Is(err, ErrUnavailable) {
		t.Fatal("oversize certificate accepted")
	}
	if err := os.Symlink(keyPath, certPath+".link"); err == nil {
		if _, err := New(certPath+".link", keyPath); !errors.Is(err, ErrUnavailable) {
			t.Fatal("symlinked certificate accepted")
		}
	}
}

func TestRemoteWrongHostTokenAndStaleHandlerCannotConsume(t *testing.T) {
	s := testService(t, true)
	invite := testInvitation(t, s, "browser")
	client := browserClient(t, s)
	for _, change := range []func(*http.Request){
		func(r *http.Request) { r.Host = "attacker.invalid" },
		func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+strings.Repeat("z", 43)) },
		func(r *http.Request) { r.Header.Add("Authorization", "Bearer "+strings.Repeat("z", 43)) },
		func(r *http.Request) { r.Header.Set("Origin", "null") },
	} {
		u, _ := url.Parse(invite.URL)
		values, _ := url.ParseQuery(u.Fragment)
		request, _ := http.NewRequest(http.MethodPost, invite.Status.Origin+"/deliver", strings.NewReader("boundary-fixture"))
		request.Header.Set("Authorization", "Bearer "+values.Get("token"))
		request.Header.Set("Content-Type", "text/plain")
		change(request)
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		if response.StatusCode != 403 || s.Status().State != "waiting" {
			t.Fatal("remote boundary failed closed")
		}
	}
	if err := s.Cancel(invite.Status.ID); err != nil {
		t.Fatal(err)
	}
	newInvite := testInvitation(t, s, "browser")
	u, _ := url.Parse(newInvite.URL)
	fields, _ := url.ParseQuery(u.Fragment)
	request := httptest.NewRequest(http.MethodPost, newInvite.Status.Origin+"/deliver", strings.NewReader("stale-fixture"))
	request.RemoteAddr = "127.0.0.1:1234"
	request.TLS = &tls.ConnectionState{}
	request.Header.Set("Authorization", "Bearer "+fields.Get("token"))
	request.Header.Set("Content-Type", "text/plain")
	response := httptest.NewRecorder()
	s.remote(invite.Status.ID, newInvite.Status.Origin, "browser", response, request)
	if response.Code != 403 || s.Status().State != "waiting" {
		t.Fatal("stale handler consumed new capability")
	}
}

func TestSenderDisablesRedirectsAndStopsOnShutdown(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { redirected.Add(1) }))
	defer target.Close()
	peer := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, 307) }))
	defer peer.Close()
	token, _ := randomID(32)
	link := peer.URL + "/#" + url.Values{"v": {"1"}, "mode": {"app"}, "token": {token}, "pin": {fingerprint(peer.Certificate())}}.Encode()
	s := testService(t, false)
	if err := s.Send(t.Context(), link, []byte("redirect-fixture")); !errors.Is(err, ErrUnconfirmed) {
		t.Fatalf("redirect = %v", err)
	}
	if redirected.Load() != 0 {
		t.Fatal("password followed a redirect")
	}
	s.Close()
	if err := s.Send(t.Context(), link, []byte("closed-fixture")); !errors.Is(err, ErrUnavailable) {
		t.Fatal("closed sender accepted work")
	}
}
