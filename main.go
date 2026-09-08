package main

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	defaultAddress   = ":8080"
	defaultTimeout   = 5 * time.Second
	defaultCacheTTL  = 10 * time.Second
	resourceCacheTTL = 4 * time.Second
	resourceInterval = 5 * time.Second
	historyWindow    = 5 * time.Minute
	maxResponseBytes = 4 << 20
)

//go:embed static/*
var staticFiles embed.FS

type config struct {
	address             string
	siloURL             *url.URL
	apiKey              string
	timeout             time.Duration
	cacheTTL            time.Duration
	hostProcDir         string
	hostNetworkStatsDir string
	plexURL             *url.URL
	plexToken           string
}

type cacheEntry struct {
	body        []byte
	contentType string
	expiresAt   time.Time
}

type proxyCache struct {
	mu      sync.Mutex
	entries map[string]cacheEntry
}

type resourceHistorySample struct {
	Timestamp int64    `json:"t"`
	CPU       *float64 `json:"cpu_pct,omitempty"`
	Memory    *float64 `json:"mem_pct,omitempty"`
	Download  *float64 `json:"net_rx_bps,omitempty"`
	Upload    *float64 `json:"net_tx_bps,omitempty"`
}

type resourceHistory struct {
	mu      sync.RWMutex
	samples []resourceHistorySample
}

type networkCounters struct {
	received    uint64
	transmitted uint64
	at          time.Time
	valid       bool
}

type hostNetworkSampler struct {
	procDir       string
	statsDir      string
	interfaceName string
	previous      networkCounters
}

type application struct {
	config    config
	client    *http.Client
	cache     proxyCache
	history   resourceHistory
	network   *hostNetworkSampler
	processes *processSampler
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}

	app := newApplication(cfg)
	server := &http.Server{
		Addr:              cfg.address,
		Handler:           app.routes(),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	go app.sampleResources(ctx)

	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("shutdown: %v", err)
		}
	}()

	log.Printf("silo monitor listening on %s", cfg.address)
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

func loadConfig() (config, error) {
	rawURL := strings.TrimSpace(os.Getenv("SILO_URL"))
	if rawURL == "" {
		return config{}, errors.New("SILO_URL is required")
	}
	parsedURL, err := url.Parse(rawURL)
	if err != nil || parsedURL.Host == "" || (parsedURL.Scheme != "http" && parsedURL.Scheme != "https") {
		return config{}, fmt.Errorf("SILO_URL must be an absolute http or https URL")
	}
	if parsedURL.User != nil || parsedURL.RawQuery != "" || parsedURL.Fragment != "" {
		return config{}, errors.New("SILO_URL must not contain credentials, a query, or a fragment")
	}
	parsedURL.Path = strings.TrimRight(parsedURL.Path, "/")

	apiKey := strings.TrimSpace(os.Getenv("SILO_API_KEY"))
	if apiKey == "" {
		return config{}, errors.New("SILO_API_KEY is required")
	}

	address := strings.TrimSpace(os.Getenv("LISTEN_ADDR"))
	if address == "" {
		address = defaultAddress
	}
	plexURL, plexToken, err := loadPlexConfig()
	if err != nil {
		return config{}, err
	}

	return config{
		address:             address,
		siloURL:             parsedURL,
		apiKey:              apiKey,
		timeout:             defaultTimeout,
		cacheTTL:            defaultCacheTTL,
		hostProcDir:         strings.TrimSpace(os.Getenv("HOST_PROC_DIR")),
		hostNetworkStatsDir: strings.TrimSpace(os.Getenv("HOST_NETWORK_STATS_DIR")),
		plexURL:             plexURL,
		plexToken:           plexToken,
	}, nil
}

func newApplication(cfg config) *application {
	app := &application{
		config: cfg,
		client: &http.Client{
			Timeout: cfg.timeout,
			Transport: &http.Transport{
				Proxy:                 http.ProxyFromEnvironment,
				MaxIdleConns:          4,
				MaxIdleConnsPerHost:   2,
				IdleConnTimeout:       60 * time.Second,
				ResponseHeaderTimeout: cfg.timeout,
			},
		},
		cache:     proxyCache{entries: make(map[string]cacheEntry)},
		processes: &processSampler{procDir: cfg.hostProcDir},
	}
	if cfg.hostNetworkStatsDir != "" || cfg.hostProcDir != "" {
		app.network = &hostNetworkSampler{procDir: cfg.hostProcDir, statsDir: cfg.hostNetworkStatsDir}
	}
	return app
}

func (a *application) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok\n")
	})
	mux.HandleFunc("GET /api/resources", a.proxyJSON("resources", "/api/v1/admin/system/resources", resourceCacheTTL))
	mux.HandleFunc("GET /api/history", a.resourceHistoryJSON)
	mux.HandleFunc("GET /api/processes", a.processCPUJSON)
	mux.HandleFunc("GET /api/sessions", a.proxyJSON("sessions", "/api/v1/admin/sessions", a.config.cacheTTL))
	mux.HandleFunc("GET /api/plex/sessions", a.plexSessionsJSON)
	mux.HandleFunc("GET /api/plex/poster", a.plexPoster)
	mux.HandleFunc("GET /api/nodes", a.proxyJSON("nodes", "/api/v1/admin/nodes", a.config.cacheTTL))
	mux.HandleFunc("GET /api/transcoder", a.transcoderSettings)
	mux.HandleFunc("PUT /api/transcoder", a.transcoderSettings)
	mux.HandleFunc("GET /api/restart-status", a.restartStatus)
	mux.HandleFunc("POST /api/restart", a.restartServer)
	mux.HandleFunc("POST /api/playback/terminate", a.terminatePlayback)

	content, err := fs.Sub(staticFiles, "static")
	if err != nil {
		panic(err)
	}
	mux.Handle("/", http.FileServer(http.FS(content)))

	return securityHeaders(mux)
}

func (a *application) sampleResources(ctx context.Context) {
	a.captureResourceSample(ctx)
	ticker := time.NewTicker(resourceInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			a.captureResourceSample(ctx)
		}
	}
}

func (a *application) captureResourceSample(ctx context.Context) {
	a.processes.sample(time.Now())
	body, _, err := a.fetch(ctx, "resources", "/api/v1/admin/system/resources", resourceCacheTTL)
	if err != nil {
		log.Printf("resource history: %v", err)
		return
	}
	var payload struct {
		Available bool   `json:"available"`
		SampledAt string `json:"sampled_at"`
		System    *struct {
			CPU         *float64 `json:"cpu_pct"`
			MemoryUsed  *float64 `json:"mem_used_mb"`
			MemoryTotal *float64 `json:"mem_total_mb"`
			Download    *float64 `json:"net_rx_bps"`
			Upload      *float64 `json:"net_tx_bps"`
		} `json:"system"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || !payload.Available || payload.System == nil {
		return
	}

	timestamp := time.Now()
	if parsed, err := time.Parse(time.RFC3339, payload.SampledAt); err == nil {
		timestamp = parsed
	}
	var memory *float64
	if payload.System.MemoryUsed != nil && payload.System.MemoryTotal != nil && *payload.System.MemoryTotal > 0 {
		percentage := *payload.System.MemoryUsed / *payload.System.MemoryTotal * 100
		memory = &percentage
	}
	download, upload := payload.System.Download, payload.System.Upload
	if a.network != nil {
		download, upload = a.network.sample(time.Now())
	}
	a.history.append(resourceHistorySample{
		Timestamp: timestamp.UnixMilli(),
		CPU:       payload.System.CPU,
		Memory:    memory,
		Download:  download,
		Upload:    upload,
	}, time.Now())
}

func (s *hostNetworkSampler) sample(now time.Time) (*float64, *float64) {
	var current networkCounters
	if s.statsDir != "" {
		current = readSysfsNetworkCounters(s.statsDir, now)
	} else {
		if s.interfaceName == "" {
			s.interfaceName = defaultRouteInterface(s.procDir)
		}
		current = readNetworkCounters(s.procDir, s.interfaceName, now)
	}
	previous := s.previous
	s.previous = current
	if !previous.valid || !current.valid {
		return nil, nil
	}
	seconds := current.at.Sub(previous.at).Seconds()
	if seconds <= 0 {
		return nil, nil
	}
	var received, transmitted uint64
	if current.received >= previous.received {
		received = current.received - previous.received
	}
	if current.transmitted >= previous.transmitted {
		transmitted = current.transmitted - previous.transmitted
	}
	download := float64(received) * 8 / seconds
	upload := float64(transmitted) * 8 / seconds
	return &download, &upload
}

func readSysfsNetworkCounters(statsDir string, now time.Time) networkCounters {
	receivedRaw, receivedErr := os.ReadFile(filepath.Join(statsDir, "rx_bytes"))
	transmittedRaw, transmittedErr := os.ReadFile(filepath.Join(statsDir, "tx_bytes"))
	if receivedErr != nil || transmittedErr != nil {
		return networkCounters{}
	}
	received, receivedErr := strconv.ParseUint(strings.TrimSpace(string(receivedRaw)), 10, 64)
	transmitted, transmittedErr := strconv.ParseUint(strings.TrimSpace(string(transmittedRaw)), 10, 64)
	if receivedErr != nil || transmittedErr != nil {
		return networkCounters{}
	}
	return networkCounters{received: received, transmitted: transmitted, at: now, valid: true}
}

func defaultRouteInterface(procDir string) string {
	raw, err := os.ReadFile(filepath.Join(procDir, "net", "route"))
	if err != nil {
		return ""
	}
	for line := range strings.Lines(string(raw)) {
		fields := strings.Fields(line)
		if len(fields) >= 4 && fields[1] == "00000000" {
			flags, err := strconv.ParseUint(fields[3], 16, 32)
			if err == nil && flags&1 != 0 {
				return fields[0]
			}
		}
	}
	return ""
}

func readNetworkCounters(procDir, interfaceName string, now time.Time) networkCounters {
	if interfaceName == "" {
		return networkCounters{}
	}
	raw, err := os.ReadFile(filepath.Join(procDir, "net", "dev"))
	if err != nil {
		return networkCounters{}
	}
	for line := range strings.Lines(string(raw)) {
		name, rest, ok := strings.Cut(line, ":")
		if !ok || strings.TrimSpace(name) != interfaceName {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 9 {
			return networkCounters{}
		}
		received, receivedErr := strconv.ParseUint(fields[0], 10, 64)
		transmitted, transmittedErr := strconv.ParseUint(fields[8], 10, 64)
		if receivedErr != nil || transmittedErr != nil {
			return networkCounters{}
		}
		return networkCounters{received: received, transmitted: transmitted, at: now, valid: true}
	}
	return networkCounters{}
}

func (h *resourceHistory) append(sample resourceHistorySample, now time.Time) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if last := len(h.samples) - 1; last >= 0 && h.samples[last].Timestamp == sample.Timestamp {
		h.samples[last] = sample
	} else {
		h.samples = append(h.samples, sample)
	}
	cutoff := now.Add(-historyWindow).UnixMilli()
	first := 0
	for first < len(h.samples) && h.samples[first].Timestamp < cutoff {
		first++
	}
	if first > 0 {
		h.samples = append([]resourceHistorySample(nil), h.samples[first:]...)
	}
}

func (a *application) resourceHistoryJSON(w http.ResponseWriter, _ *http.Request) {
	a.history.mu.RLock()
	samples := append([]resourceHistorySample(nil), a.history.samples...)
	a.history.mu.RUnlock()
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(samples)
}

func (a *application) proxyJSON(cacheKey, upstreamPath string, cacheTTL time.Duration) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		body, contentType, err := a.fetch(r.Context(), cacheKey, upstreamPath, cacheTTL)
		if err != nil {
			log.Printf("upstream %s: %v", cacheKey, err)
			writeJSONError(w, http.StatusBadGateway, "Silo is unavailable")
			return
		}

		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", contentType)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(body)
	}
}

func (a *application) fetch(ctx context.Context, cacheKey, upstreamPath string, cacheTTL time.Duration) ([]byte, string, error) {
	a.cache.mu.Lock()
	if cached, ok := a.cache.entries[cacheKey]; ok && time.Now().Before(cached.expiresAt) {
		a.cache.mu.Unlock()
		return append([]byte(nil), cached.body...), cached.contentType, nil
	}
	a.cache.mu.Unlock()

	upstreamURL := *a.config.siloURL
	upstreamURL.Path = strings.TrimRight(upstreamURL.Path, "/") + upstreamPath
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, upstreamURL.String(), nil)
	if err != nil {
		return nil, "", err
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+a.config.apiKey)

	response, err := a.client.Do(request)
	if err != nil {
		return nil, "", err
	}
	defer response.Body.Close()

	limited := io.LimitReader(response.Body, maxResponseBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, "", err
	}
	if len(body) > maxResponseBytes {
		return nil, "", errors.New("upstream response exceeded 4 MiB")
	}
	if response.StatusCode != http.StatusOK {
		return nil, "", fmt.Errorf("Silo returned %s", response.Status)
	}
	if !json.Valid(body) {
		return nil, "", errors.New("Silo returned invalid JSON")
	}

	contentType := response.Header.Get("Content-Type")
	if contentType == "" {
		contentType = "application/json"
	}
	a.cache.mu.Lock()
	a.cache.entries[cacheKey] = cacheEntry{
		body:        append([]byte(nil), body...),
		contentType: contentType,
		expiresAt:   time.Now().Add(cacheTTL),
	}
	a.cache.mu.Unlock()
	return body, contentType, nil
}

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", "default-src 'self'; img-src 'self' https: http: data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func writeJSONError(w http.ResponseWriter, status int, message string) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": message})
}
