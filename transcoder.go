package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

func (app *application) restartStatus(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	body, status, err := app.transcoderRequest(request, http.MethodGet, "/api/v1/admin/server/status", nil)
	if err != nil || status != http.StatusOK {
		writeJSONError(writer, http.StatusBadGateway, "Silo restart status is unavailable")
		return
	}
	var result struct {
		RestartRequired  *bool  `json:"restart_required"`
		StartedAt        string `json:"started_at"`
		RestartRequested bool   `json:"restart_requested"`
	}
	if json.Unmarshal(body, &result) != nil || result.RestartRequired == nil || result.StartedAt == "" {
		writeJSONError(writer, http.StatusBadGateway, "Invalid Silo restart status")
		return
	}
	_ = json.NewEncoder(writer).Encode(result)
}

func sameOriginSettingsRequest(request *http.Request) bool {
	origin, err := url.Parse(request.Header.Get("Origin"))
	contentType, _, _ := mime.ParseMediaType(request.Header.Get("Content-Type"))
	return err == nil && (origin.Scheme == "http" || origin.Scheme == "https") && origin.Host == request.Host && origin.User == nil && origin.Path == "" && origin.RawQuery == "" && origin.Fragment == "" && request.Header.Get("X-Siloscope-Settings") == "1" && contentType == "application/json" && request.Header.Get("Sec-Fetch-Site") != "cross-site"
}

func (app *application) restartServer(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	if !sameOriginSettingsRequest(request) {
		writeJSONError(writer, http.StatusForbidden, "Same-origin settings request required")
		return
	}
	body, status, err := app.transcoderRequest(request, http.MethodPost, "/api/v1/admin/server/restart", []byte(`{}`))
	if status == http.StatusServiceUnavailable || status == http.StatusForbidden {
		writeJSONError(writer, status, "Silo restart is unavailable or not permitted")
		return
	}
	var result struct {
		Status string `json:"status"`
	}
	if err != nil || status != http.StatusAccepted || json.Unmarshal(body, &result) != nil || (result.Status != "restart_requested" && result.Status != "already_requested") {
		writeJSONError(writer, http.StatusBadGateway, "Restart request could not be confirmed. Check server status before retrying.")
		return
	}
	writer.WriteHeader(http.StatusAccepted)
	_ = json.NewEncoder(writer).Encode(result)
}

type transcoderField struct {
	Key         string      `json:"key"`
	Label       string      `json:"label"`
	Group       string      `json:"group"`
	Type        string      `json:"type"`
	Options     [][2]string `json:"options,omitempty"`
	Min         int         `json:"min,omitempty"`
	Placeholder string      `json:"placeholder,omitempty"`
}

func transcoderFields() []transcoderField {
	body, err := staticFiles.ReadFile("static/transcoder-fields.json")
	if err != nil {
		panic(err)
	}
	var fields []transcoderField
	if err := json.Unmarshal(body, &fields); err != nil {
		panic(err)
	}
	return fields
}

func validTranscoderValue(field transcoderField, value string) bool {
	if len(value) > 4096 || strings.ContainsAny(value, "\x00\r\n") {
		return false
	}
	switch field.Type {
	case "boolean":
		return value == "true" || value == "false"
	case "select":
		for _, option := range field.Options {
			if value == option[0] {
				return true
			}
		}
		return false
	case "number":
		number, err := strconv.ParseInt(value, 10, 32)
		if err != nil || number < int64(field.Min) {
			return false
		}
		return field.Key != "playback.segment_retention_seconds" || number == 0 || number >= 120
	case "text":
		return true
	}
	return false
}

func (app *application) transcoderRequest(request *http.Request, method, endpoint string, body []byte) ([]byte, int, error) {
	upstream := *app.config.siloURL
	upstream.Path = strings.TrimRight(upstream.Path, "/") + endpoint
	upstreamRequest, err := http.NewRequestWithContext(request.Context(), method, upstream.String(), bytes.NewReader(body))
	if err != nil {
		return nil, 0, err
	}
	upstreamRequest.Header.Set("Authorization", "Bearer "+app.config.apiKey)
	upstreamRequest.Header.Set("Accept", "application/json")
	if method == http.MethodPut || method == http.MethodPost {
		upstreamRequest.Header.Set("Content-Type", "application/json")
	}
	client := *app.client
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(upstreamRequest)
	if err != nil {
		return nil, 0, err
	}
	defer response.Body.Close()
	result, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(result) > maxResponseBytes || !json.Valid(result) {
		return nil, response.StatusCode, errors.New("invalid settings response")
	}
	return result, response.StatusCode, nil
}

func (app *application) transcoderSettings(writer http.ResponseWriter, request *http.Request) {
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	fields := transcoderFields()
	allowed := make(map[string]transcoderField, len(fields))
	for _, field := range fields {
		allowed[field.Key] = field
	}
	if request.Method == http.MethodPut {
		if !sameOriginSettingsRequest(request) {
			writeJSONError(writer, http.StatusForbidden, "Same-origin settings request required")
			return
		}
		var update struct {
			Values map[string]string `json:"values"`
		}
		decoder := json.NewDecoder(http.MaxBytesReader(writer, request.Body, 65536))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&update); err != nil {
			writeJSONError(writer, http.StatusBadRequest, "Invalid settings request")
			return
		}
		var extra any
		if decoder.Decode(&extra) != io.EOF || len(update.Values) == 0 || len(update.Values) > len(allowed) {
			writeJSONError(writer, http.StatusBadRequest, "Invalid settings request")
			return
		}
		for key, value := range update.Values {
			field, exists := allowed[key]
			if !exists || !validTranscoderValue(field, value) {
				writeJSONError(writer, http.StatusBadRequest, "Unsupported setting or invalid value")
				return
			}
		}
		payload, _ := json.Marshal(update)
		body, status, err := app.transcoderRequest(request, http.MethodPut, "/api/v1/admin/settings", payload)
		if status == http.StatusBadRequest || status == http.StatusConflict || status == http.StatusUnprocessableEntity {
			writeJSONError(writer, http.StatusBadRequest, "Silo rejected these settings. Check values and routing compatibility.")
			return
		}
		if err != nil || status != http.StatusOK {
			writeJSONError(writer, http.StatusBadGateway, "Settings save could not be confirmed. Reload before retrying.")
			return
		}
		var result struct {
			Values          map[string]string `json:"values"`
			RestartRequired bool              `json:"restart_required"`
			RestartKeys     []string          `json:"restart_required_keys"`
		}
		if json.Unmarshal(body, &result) != nil || result.Values == nil {
			writeJSONError(writer, http.StatusBadGateway, "Settings save could not be confirmed. Reload before retrying.")
			return
		}
		for key := range result.Values {
			if _, exists := allowed[key]; !exists {
				delete(result.Values, key)
			}
		}
		keys := make([]string, 0)
		for _, key := range result.RestartKeys {
			if _, exists := allowed[key]; exists {
				keys = append(keys, key)
			}
		}
		result.RestartKeys = keys
		_ = json.NewEncoder(writer).Encode(result)
		return
	}
	body, status, err := app.transcoderRequest(request, http.MethodGet, "/api/v1/admin/settings/effective", nil)
	if err != nil || status != http.StatusOK {
		writeJSONError(writer, http.StatusBadGateway, "Silo transcoder settings are unavailable")
		return
	}
	var values map[string]string
	if json.Unmarshal(body, &values) != nil || values == nil {
		writeJSONError(writer, http.StatusBadGateway, "Invalid Silo settings response")
		return
	}
	for key := range values {
		if _, exists := allowed[key]; !exists {
			delete(values, key)
		}
	}
	body, status, err = app.transcoderRequest(request, http.MethodGet, "/api/v1/admin/settings/restart-keys", nil)
	if err != nil || status != http.StatusOK {
		writeJSONError(writer, http.StatusBadGateway, "Silo restart requirements are unavailable")
		return
	}
	var registry struct {
		Keys     []string `json:"keys"`
		Prefixes []string `json:"prefixes"`
	}
	if json.Unmarshal(body, &registry) != nil {
		writeJSONError(writer, http.StatusBadGateway, "Invalid Silo restart requirements")
		return
	}
	restartKeys := make([]string, 0)
	for _, field := range fields {
		restart := false
		for _, key := range registry.Keys {
			if field.Key == key {
				restart = true
			}
		}
		for _, prefix := range registry.Prefixes {
			if strings.HasPrefix(field.Key, prefix) {
				restart = true
			}
		}
		if restart {
			restartKeys = append(restartKeys, field.Key)
		}
	}
	_ = json.NewEncoder(writer).Encode(struct {
		Fields      []transcoderField `json:"fields"`
		Values      map[string]string `json:"values"`
		RestartKeys []string          `json:"restart_keys"`
	}{fields, values, restartKeys})
}
