package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testApplication(t *testing.T, upstream http.Handler) (*application, *httptest.Server) {
	t.Helper()
	server := httptest.NewServer(upstream)
	t.Cleanup(server.Close)
	parsed, err := url.Parse(server.URL + "/base")
	if err != nil {
		t.Fatal(err)
	}
	app := newApplication(config{
		siloURL:  parsed,
		apiKey:   "sa_monitor_secret",
		timeout:  time.Second,
		cacheTTL: time.Minute,
	})
	return app, server
}

func TestProxyForwardsBearerAndCachesResponse(t *testing.T) {
	var calls atomic.Int32
	app, _ := testApplication(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if got := r.URL.Path; got != "/base/api/v1/admin/system/resources" {
			t.Errorf("path = %q", got)
		}
		if got := r.Header.Get("Authorization"); got != "Bearer sa_monitor_secret" {
			t.Errorf("Authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"available":true}`)
	}))

	handler := app.routes()
	for range 2 {
		request := httptest.NewRequest(http.MethodGet, "/api/resources", nil)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusOK {
			t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
		}
		if strings.Contains(response.Body.String(), "sa_monitor_secret") {
			t.Fatal("response leaked API key")
		}
	}

	if got := calls.Load(); got != 1 {
		t.Fatalf("upstream calls = %d, want 1", got)
	}
}

func TestProxyRejectsInvalidJSON(t *testing.T) {
	app, _ := testApplication(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "not json")
	}))

	response := httptest.NewRecorder()
	app.routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/sessions", nil))
	if response.Code != http.StatusBadGateway {
		t.Fatalf("status = %d, want %d", response.Code, http.StatusBadGateway)
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("Cache-Control = %q", got)
	}
}

func TestProxyDoesNotCacheFailures(t *testing.T) {
	var calls atomic.Int32
	app, _ := testApplication(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(w, "temporary failure", http.StatusServiceUnavailable)
			return
		}
		_, _ = io.WriteString(w, `[]`)
	}))

	handler := app.routes()
	first := httptest.NewRecorder()
	handler.ServeHTTP(first, httptest.NewRequest(http.MethodGet, "/api/sessions", nil))
	if first.Code != http.StatusBadGateway {
		t.Fatalf("first status = %d", first.Code)
	}

	second := httptest.NewRecorder()
	handler.ServeHTTP(second, httptest.NewRequest(http.MethodGet, "/api/sessions", nil))
	if second.Code != http.StatusOK {
		t.Fatalf("second status = %d, body = %s", second.Code, second.Body.String())
	}
	if calls.Load() != 2 {
		t.Fatalf("upstream calls = %d, want 2", calls.Load())
	}
}

func TestIndependentUpstreamRequestsRunConcurrently(t *testing.T) {
	started := make(chan struct{}, 2)
	release := make(chan struct{})
	app, _ := testApplication(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		started <- struct{}{}
		<-release
		_, _ = io.WriteString(w, `{}`)
	}))

	errors := make(chan error, 2)
	go func() {
		_, _, err := app.fetch(context.Background(), "resources", "/api/v1/admin/system/resources", time.Minute)
		errors <- err
	}()
	go func() {
		_, _, err := app.fetch(context.Background(), "sessions", "/api/v1/admin/sessions", time.Minute)
		errors <- err
	}()

	for range 2 {
		select {
		case <-started:
		case <-time.After(time.Second):
			close(release)
			t.Fatal("independent request was blocked by the cache lock")
		}
	}
	close(release)
	for range 2 {
		if err := <-errors; err != nil {
			t.Fatal(err)
		}
	}
}

func TestHealthDoesNotDependOnSilo(t *testing.T) {
	app, _ := testApplication(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "down", http.StatusServiceUnavailable)
	}))

	response := httptest.NewRecorder()
	app.routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/healthz", nil))
	if response.Code != http.StatusOK || response.Body.String() != "ok\n" {
		t.Fatalf("health response = %d %q", response.Code, response.Body.String())
	}
}

func TestResourceHistoryCapturesSystemSample(t *testing.T) {
	app, _ := testApplication(t, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{
			"available": true,
			"system": {
				"cpu_pct": 42,
				"mem_used_mb": 2048,
				"mem_total_mb": 8192,
				"net_rx_bps": 12000000,
				"net_tx_bps": 34000000
			}
		}`)
	}))

	app.captureResourceSample(context.Background())
	response := httptest.NewRecorder()
	app.routes().ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/api/history", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d", response.Code)
	}
	var samples []resourceHistorySample
	if err := json.Unmarshal(response.Body.Bytes(), &samples); err != nil {
		t.Fatal(err)
	}
	if len(samples) != 1 {
		t.Fatalf("samples = %d, want 1", len(samples))
	}
	if samples[0].CPU == nil || *samples[0].CPU != 42 {
		t.Fatalf("cpu = %v", samples[0].CPU)
	}
	if samples[0].Memory == nil || *samples[0].Memory != 25 {
		t.Fatalf("memory = %v", samples[0].Memory)
	}
	if samples[0].Download == nil || *samples[0].Download != 12000000 {
		t.Fatalf("download = %v", samples[0].Download)
	}
	if samples[0].Upload == nil || *samples[0].Upload != 34000000 {
		t.Fatalf("upload = %v", samples[0].Upload)
	}
}

func TestResourceHistoryKeepsFiveMinutes(t *testing.T) {
	now := time.Date(2026, 9, 5, 12, 5, 1, 0, time.UTC)
	history := resourceHistory{}
	history.append(resourceHistorySample{Timestamp: now.Add(-historyWindow - time.Second).UnixMilli()}, now)
	history.append(resourceHistorySample{Timestamp: now.Add(-historyWindow).UnixMilli()}, now)
	history.append(resourceHistorySample{Timestamp: now.UnixMilli()}, now)

	if len(history.samples) != 2 {
		t.Fatalf("samples = %d, want 2", len(history.samples))
	}
	if history.samples[0].Timestamp != now.Add(-historyWindow).UnixMilli() {
		t.Fatalf("oldest sample = %d", history.samples[0].Timestamp)
	}
}

func TestHostNetworkSamplerUsesDefaultRouteInterface(t *testing.T) {
	procDir := t.TempDir()
	if err := os.MkdirAll(filepath.Join(procDir, "net"), 0o755); err != nil {
		t.Fatal(err)
	}
	route := "Iface Destination Gateway Flags RefCnt Use Metric Mask MTU Window IRTT\n" +
		"enp0s6 00000000 0100000A 0003 0 0 0 00000000 0 0 0\n"
	if err := os.WriteFile(filepath.Join(procDir, "net", "route"), []byte(route), 0o644); err != nil {
		t.Fatal(err)
	}
	writeCounters := func(received, transmitted string) {
		t.Helper()
		data := "Inter-| Receive | Transmit\n face |bytes |bytes\n" +
			" enp0s6: " + received + " 0 0 0 0 0 0 0 " + transmitted + " 0 0 0 0 0 0 0\n" +
			" docker0: 999999 0 0 0 0 0 0 0 999999 0 0 0 0 0 0 0\n"
		if err := os.WriteFile(filepath.Join(procDir, "net", "dev"), []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	sampler := hostNetworkSampler{procDir: procDir}
	start := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	writeCounters("1000", "2000")
	download, upload := sampler.sample(start)
	if download != nil || upload != nil {
		t.Fatal("first reading should establish a baseline")
	}
	writeCounters("6000", "12000")
	download, upload = sampler.sample(start.Add(5 * time.Second))
	if download == nil || *download != 8000 {
		t.Fatalf("download = %v, want 8000", download)
	}
	if upload == nil || *upload != 16000 {
		t.Fatalf("upload = %v, want 16000", upload)
	}
	if sampler.interfaceName != "enp0s6" {
		t.Fatalf("interface = %q", sampler.interfaceName)
	}
}

func TestHostNetworkSamplerUsesSysfsCounters(t *testing.T) {
	statsDir := t.TempDir()
	writeCounters := func(received, transmitted string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(statsDir, "rx_bytes"), []byte(received+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(statsDir, "tx_bytes"), []byte(transmitted+"\n"), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	sampler := hostNetworkSampler{statsDir: statsDir}
	start := time.Date(2026, 9, 5, 12, 0, 0, 0, time.UTC)
	writeCounters("1000", "2000")
	download, upload := sampler.sample(start)
	if download != nil || upload != nil {
		t.Fatal("first reading should establish a baseline")
	}
	writeCounters("6000", "12000")
	download, upload = sampler.sample(start.Add(5 * time.Second))
	if download == nil || *download != 8000 {
		t.Fatalf("download = %v, want 8000", download)
	}
	if upload == nil || *upload != 16000 {
		t.Fatalf("upload = %v, want 16000", upload)
	}
}
