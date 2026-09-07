package main

import (
	"encoding/json"
	"encoding/xml"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestPlexSessionsNormalizeAndCache(t *testing.T) {
	var calls atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		calls.Add(1)
		if request.URL.Path != "/base/status/sessions" || request.Header.Get("X-Plex-Token") != "private-token" || request.URL.RawQuery != "" {
			t.Error("incorrect Plex request")
		}
		_, _ = io.WriteString(writer, `<MediaContainer><Video sessionKey="7" ratingKey="45" grandparentRatingKey="12" type="episode" title="Pilot" grandparentTitle="Example" parentIndex="1" index="2" duration="1800000" viewOffset="60000"><User title="Alex"/><Player title="TV" state="paused"/><Media videoResolution="1080"/><TranscodeSession videoDecision="copy" audioDecision="transcode"/></Video><Track sessionKey="8" ratingKey="46" type="track" title="Song" grandparentTitle="Artist" parentTitle="Album" duration="120000"><Player state="playing" product="Plexamp"/></Track></MediaContainer>`)
	}))
	defer upstream.Close()
	parsed, _ := url.Parse(upstream.URL + "/base")
	app := newApplication(config{plexURL: parsed, plexToken: "private-token", timeout: time.Second, cacheTTL: time.Minute})
	for range 2 {
		response := httptest.NewRecorder()
		app.routes().ServeHTTP(response, httptest.NewRequest("GET", "/api/plex/sessions", nil))
		if response.Code != 200 {
			t.Fatalf("status %d: %s", response.Code, response.Body)
		}
		var result struct {
			Enabled  bool
			Sessions []plexPlayback
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if !result.Enabled || len(result.Sessions) != 2 {
			t.Fatalf("unexpected response: %+v", result)
		}
		session := result.Sessions[0]
		if session.ID != "plex:7" || !session.Paused || session.Method != "audio" || session.Duration != 1800 || session.Position != 60 || session.Poster != "/api/plex/poster?id=12" || *session.Season != 1 || *session.Episode != 2 {
			t.Fatalf("unexpected session: %+v", session)
		}
		if result.Sessions[1].Subtitle != "Artist / Album" || result.Sessions[1].Client != "Plexamp" {
			t.Fatal("track mapping incorrect")
		}
		if strings.Contains(response.Body.String(), "private-token") {
			t.Fatal("token leaked")
		}
	}
	if calls.Load() != 1 {
		t.Fatal("Plex response not cached")
	}
}

func TestPlexOptionalAndFailureRecovery(t *testing.T) {
	app := newApplication(config{})
	disabled := httptest.NewRecorder()
	app.routes().ServeHTTP(disabled, httptest.NewRequest("GET", "/api/plex/sessions", nil))
	if disabled.Code != 200 || disabled.Body.String() != `{"enabled":false,"sessions":[]}` {
		t.Fatal("disabled Plex response incorrect")
	}
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			http.Error(writer, "private-token", 401)
			return
		}
		_, _ = io.WriteString(writer, `<MediaContainer/>`)
	}))
	defer server.Close()
	app.config.plexURL, _ = url.Parse(server.URL)
	app.config.plexToken = "private-token"
	for _, expected := range []int{502, 200} {
		response := httptest.NewRecorder()
		app.routes().ServeHTTP(response, httptest.NewRequest("GET", "/api/plex/sessions", nil))
		if response.Code != expected || strings.Contains(response.Body.String(), "private-token") {
			t.Fatalf("unexpected response %d %s", response.Code, response.Body)
		}
	}
}

func TestPlexPosterRejectsPathsAndRedirects(t *testing.T) {
	var leaked atomic.Bool
	target := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) { leaked.Store(true) }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		http.Redirect(writer, request, target.URL, 302)
	}))
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	app := newApplication(config{plexURL: parsed, plexToken: "secret", timeout: time.Second})
	for _, test := range []struct {
		path string
		code int
	}{{"/api/plex/poster?id=../../secret", 400}, {"/api/plex/poster?id=12", 502}, {"/api/plex/sessions", 502}} {
		response := httptest.NewRecorder()
		app.routes().ServeHTTP(response, httptest.NewRequest("GET", test.path, nil))
		if response.Code != test.code {
			t.Fatalf("%s: got %d", test.path, response.Code)
		}
	}
	if leaked.Load() {
		t.Fatal("followed redirect with Plex credentials")
	}
}

func TestPlexConfig(t *testing.T) {
	for _, test := range []struct {
		address, token string
		valid          bool
	}{{"", "", true}, {"http://plex:32400", "token", true}, {"http://plex:32400", "", false}, {"", "token", false}, {"file:///tmp/plex", "token", false}, {"http://plex/?X-Plex-Token=secret", "token", false}, {"http://user:secret@plex", "token", false}} {
		t.Setenv("PLEX_URL", test.address)
		t.Setenv("PLEX_TOKEN", test.token)
		_, _, err := loadPlexConfig()
		if (err == nil) != test.valid {
			t.Errorf("config validity mismatch for %q", test.address)
		}
	}
}

func TestPlexPlaybackMethods(t *testing.T) {
	for _, test := range []struct{ name, media, expected string }{
		{"direct play", `<Media><Part decision="directplay"/></Media>`, "direct_play"},
		{"direct stream", `<Media><Part decision="transcode"><Stream streamType="1" decision="copy"/></Part></Media>`, "remux"},
		{"video transcode", `<Media videoDecision="transcode"/>`, "transcode"},
		{"audio transcode", `<Media audioDecision="transcode"/>`, "audio"},
		{"selected media", `<Media videoDecision="transcode"/><Media selected="1" videoDecision="directplay"/>`, "direct_play"},
		{"stream transcode", `<Media><Part><Stream streamType="1" decision="transcode"/></Part></Media>`, "transcode"},
	} {
		t.Run(test.name, func(t *testing.T) {
			var metadata plexMetadata
			if err := xml.Unmarshal([]byte(`<Video type="movie" title="Movie">`+test.media+`</Video>`), &metadata); err != nil {
				t.Fatal(err)
			}
			if session := normalizePlexSession(metadata); session.Method != test.expected {
				t.Fatalf("got %s, want %s", session.Method, test.expected)
			}
		})
	}
}

func TestPlexInvalidResponses(t *testing.T) {
	for _, body := range []string{`<MediaContainer`, `<html/>`, strings.Repeat("x", maxResponseBytes+1)} {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(writer, body) }))
		parsed, _ := url.Parse(server.URL)
		app := newApplication(config{plexURL: parsed, timeout: time.Second})
		response := httptest.NewRecorder()
		app.routes().ServeHTTP(response, httptest.NewRequest("GET", "/api/plex/sessions", nil))
		server.Close()
		if response.Code != 502 {
			t.Fatalf("invalid response accepted: %d", response.Code)
		}
	}
}

func TestPlexTimeout(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) { <-request.Context().Done() }))
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	app := newApplication(config{plexURL: parsed, timeout: 20 * time.Millisecond})
	response := httptest.NewRecorder()
	app.routes().ServeHTTP(response, httptest.NewRequest("GET", "/api/plex/sessions", nil))
	if response.Code != 502 {
		t.Fatalf("timeout status: %d", response.Code)
	}
}

func TestPlexPoster(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/library/metadata/12/thumb" || request.Header.Get("X-Plex-Token") != "private-token" {
			t.Error("unexpected poster request")
		}
		writer.Header().Set("Content-Type", "image/jpeg")
		_, _ = writer.Write([]byte{0xff, 0xd8, 0xff})
	}))
	defer server.Close()
	parsed, _ := url.Parse(server.URL)
	app := newApplication(config{plexURL: parsed, plexToken: "private-token", timeout: time.Second})
	response := httptest.NewRecorder()
	app.routes().ServeHTTP(response, httptest.NewRequest("GET", "/api/plex/poster?id=12", nil))
	if response.Code != 200 || response.Header().Get("Content-Type") != "image/jpeg" || response.Body.Len() != 3 {
		t.Fatal("poster not returned")
	}
}
