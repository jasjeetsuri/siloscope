package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type processCPU struct {
	PID     int     `json:"-"`
	Name    string  `json:"name"`
	Percent float64 `json:"cpu_pct"`
}

type processSnapshot struct {
	Available bool         `json:"available"`
	SampledAt time.Time    `json:"sampled_at"`
	Processes []processCPU `json:"processes"`
}

type processTicks struct {
	name    string
	ticks   uint64
	started uint64
}

type processSampler struct {
	mu       sync.RWMutex
	procDir  string
	total    uint64
	previous map[int]processTicks
	latest   processSnapshot
}

func parseProcessTicks(raw string) (processTicks, error) {
	start := strings.IndexByte(raw, '(')
	end := strings.LastIndexByte(raw, ')')
	if start < 0 || end <= start {
		return processTicks{}, fmt.Errorf("invalid process name")
	}
	fields := strings.Fields(raw[end+1:])
	if len(fields) < 20 {
		return processTicks{}, fmt.Errorf("incomplete process counters")
	}
	user, userErr := strconv.ParseUint(fields[11], 10, 64)
	system, systemErr := strconv.ParseUint(fields[12], 10, 64)
	started, startedErr := strconv.ParseUint(fields[19], 10, 64)
	if userErr != nil || systemErr != nil || startedErr != nil {
		return processTicks{}, fmt.Errorf("invalid process counters")
	}
	return processTicks{name: raw[start+1 : end], ticks: user + system, started: started}, nil
}

func readProcessTicks(procDir string) (uint64, map[int]processTicks, error) {
	raw, err := os.ReadFile(filepath.Join(procDir, "stat"))
	if err != nil {
		return 0, nil, err
	}
	firstLine, _, _ := strings.Cut(string(raw), "\n")
	fields := strings.Fields(firstLine)
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, nil, fmt.Errorf("missing aggregate CPU counters")
	}
	var total uint64
	for _, field := range fields[1:min(len(fields), 9)] {
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return 0, nil, err
		}
		total += value
	}
	entries, err := os.ReadDir(procDir)
	if err != nil {
		return 0, nil, err
	}
	processes := make(map[int]processTicks)
	for _, entry := range entries {
		pid, err := strconv.Atoi(entry.Name())
		if err != nil || pid <= 0 || !entry.IsDir() {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(procDir, entry.Name(), "stat"))
		if err != nil {
			continue
		}
		if counters, err := parseProcessTicks(string(raw)); err == nil {
			processes[pid] = counters
		}
	}
	return total, processes, nil
}

func (sampler *processSampler) sample(now time.Time) {
	sampler.mu.Lock()
	defer sampler.mu.Unlock()
	sampler.latest = processSnapshot{SampledAt: now, Processes: []processCPU{}}
	if sampler.procDir == "" {
		return
	}
	total, current, err := readProcessTicks(sampler.procDir)
	if err != nil {
		sampler.previous = nil
		return
	}
	previous, previousTotal := sampler.previous, sampler.total
	sampler.previous, sampler.total = current, total
	if previous == nil || total <= previousTotal {
		return
	}
	for pid, counters := range current {
		prior, exists := previous[pid]
		if !exists || prior.started != counters.started || counters.ticks < prior.ticks {
			continue
		}
		percent := min(100, float64(counters.ticks-prior.ticks)/float64(total-previousTotal)*100)
		sampler.latest.Processes = append(sampler.latest.Processes, processCPU{PID: pid, Name: counters.name, Percent: percent})
	}
	sort.Slice(sampler.latest.Processes, func(left, right int) bool {
		if sampler.latest.Processes[left].Percent == sampler.latest.Processes[right].Percent {
			return sampler.latest.Processes[left].PID < sampler.latest.Processes[right].PID
		}
		return sampler.latest.Processes[left].Percent > sampler.latest.Processes[right].Percent
	})
	if len(sampler.latest.Processes) > 3 {
		sampler.latest.Processes = sampler.latest.Processes[:3]
	}
	sampler.latest.Available = len(sampler.latest.Processes) > 0
}

func (app *application) processCPUJSON(writer http.ResponseWriter, _ *http.Request) {
	app.processes.mu.RLock()
	defer app.processes.mu.RUnlock()
	writer.Header().Set("Cache-Control", "no-store")
	writer.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(writer).Encode(app.processes.latest)
}
