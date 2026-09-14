package main

import (
	"context"
	"encoding/json"
	"strings"
	"time"
)

type serviceOutage struct {
	Active   bool      `json:"active"`
	Since    time.Time `json:"-"`
	LastSeen time.Time `json:"-"`
}

func (service *notificationService) observeService(key, label string, healthy *bool, now time.Time) {
	service.mu.Lock()
	defer service.mu.Unlock()
	changed := false
	for id, device := range service.store.Devices {
		if !device.Rules.ServiceDown {
			continue
		}
		if device.Outages == nil {
			device.Outages = make(map[string]*serviceOutage)
		}
		outage := device.Outages[key]
		if outage == nil {
			outage = &serviceOutage{}
			device.Outages[key] = outage
		}
		if healthy == nil {
			outage.Since = time.Time{}
			outage.LastSeen = time.Time{}
			continue
		}
		if now.Before(outage.LastSeen) || now.Sub(outage.LastSeen) > 35*time.Second {
			outage.Since = time.Time{}
		}
		outage.LastSeen = now
		if *healthy {
			outage.Since = time.Time{}
			if outage.Active && service.enqueue(id, pushMessage{Title: "Service recovered", Body: activityText(label) + " is available again.", Tag: "service-" + key, URL: "/?view=system"}) {
				outage.Active = false
				changed = true
			}
		} else {
			if outage.Since.IsZero() {
				outage.Since = now
			}
			if !outage.Active && now.Sub(outage.Since) >= time.Minute && service.enqueue(id, pushMessage{Title: "Service unavailable", Body: activityText(label) + " has been unavailable for at least 60 seconds.", Tag: "service-" + key, URL: "/?view=system"}) {
				outage.Active = true
				changed = true
			}
		}
	}
	if changed {
		service.persistAlerts()
	}
}

func (service *notificationService) reconcileNodes(present map[string]bool) {
	service.mu.Lock()
	defer service.mu.Unlock()
	changed := false
	for _, device := range service.store.Devices {
		for key, outage := range device.Outages {
			if !strings.HasPrefix(key, "node:") {
				continue
			}
			if present == nil {
				outage.Since = time.Time{}
				outage.LastSeen = time.Time{}
			} else if !present[key] {
				delete(device.Outages, key)
				changed = true
			}
		}
	}
	if changed {
		service.persistAlerts()
	}
}

func (app *application) pollNodeAlerts(ctx context.Context) {
	service := app.notifications
	if service == nil {
		return
	}
	service.mu.Lock()
	enabled := false
	for _, device := range service.store.Devices {
		enabled = enabled || device.Rules.ServiceDown
	}
	service.mu.Unlock()
	if !enabled {
		return
	}
	body, _, err := app.fetch(ctx, "nodes", "/api/v2/admin/nodes", app.config.cacheTTL)
	var nodes []struct {
		ID      json.RawMessage `json:"id"`
		Name    string          `json:"name"`
		Enabled *bool           `json:"enabled"`
		Healthy *bool           `json:"healthy"`
		Checked *time.Time      `json:"last_health_check"`
	}
	if err != nil || json.Unmarshal(body, &nodes) != nil || nodes == nil {
		service.reconcileNodes(nil)
		return
	}
	present := make(map[string]bool)
	now := time.Now()
	for _, node := range nodes {
		id := (notificationSession{ID: node.ID}).key()
		if id == "" || node.Enabled == nil || !*node.Enabled {
			continue
		}
		key := "node:" + id
		present[key] = true
		healthy := node.Healthy
		if node.Checked == nil || now.Sub(*node.Checked) > 45*time.Second || node.Checked.After(now.Add(5*time.Second)) {
			healthy = nil
		}
		label := "Node " + id
		if strings.TrimSpace(node.Name) != "" {
			label = "Node " + activityText(node.Name)
		}
		service.observeService(key, label, healthy, now)
	}
	service.reconcileNodes(present)
}
