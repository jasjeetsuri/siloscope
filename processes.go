package main

import (
	"encoding/json"
	"fmt"
	"math"
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
	CPU       *float64     `json:"cpu_pct,omitempty"`
	Load1     *float64     `json:"load1,omitempty"`
	Cores     int          `json:"cores,omitempty"`
	Processes []processCPU `json:"processes"`
}

type processCPUTime struct {
	total uint64
	idle  uint64
	cores int
}

type processTicks struct {
	name    string
	ticks   uint64
	started uint64
}

type processSampler struct {
	mu       sync.RWMutex
	procDir  string
	total    processCPUTime
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

func readProcessTicks(procDir string) (processCPUTime, map[int]processTicks, error) {
	var aggregate processCPUTime
	raw, err := os.ReadFile(filepath.Join(procDir, "stat"))
	if err != nil {
		return aggregate, nil, err
	}
	firstLine, _, _ := strings.Cut(string(raw), "\n")
	fields := strings.Fields(firstLine)
	if len(fields) < 5 || fields[0] != "cpu" {
		return aggregate, nil, fmt.Errorf("missing aggregate CPU counters")
	}
	for index, field := range fields[1:min(len(fields), 9)] {
		value, err := strconv.ParseUint(field, 10, 64)
		if err != nil {
			return aggregate, nil, err
		}
		aggregate.total += value
		if index == 3 || index == 4 {
			aggregate.idle += value
		}
	}
	for _, line := range strings.Split(string(raw), "\n") {
		columns := strings.Fields(line)
		if len(columns) > 0 && strings.HasPrefix(columns[0], "cpu") && columns[0] != "cpu" {
			aggregate.cores++
		}
	}
	entries, err := os.ReadDir(procDir)
	if err != nil {
		return aggregate, nil, err
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
	return aggregate, processes, nil
}

func readHostLoadAverage(procDir string) *float64 {
	raw, err := os.ReadFile(filepath.Join(procDir, "loadavg"))
	if err != nil {
		return nil
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return nil
	}
	load, err := strconv.ParseFloat(fields[0], 64)
	if err != nil || load < 0 || math.IsNaN(load) || math.IsInf(load, 0) {
		return nil
	}
	return &load
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
	if previous == nil || total.total <= previousTotal.total || total.idle < previousTotal.idle {
		return
	}
	totalDelta := total.total - previousTotal.total
	idleDelta := total.idle - previousTotal.idle
	if idleDelta > totalDelta {
		return
	}
	percent := float64(totalDelta-idleDelta) / float64(totalDelta) * 100
	sampler.latest.CPU = &percent
	sampler.latest.Cores = total.cores
	sampler.latest.Load1 = readHostLoadAverage(sampler.procDir)
	for pid, counters := range current {
		prior, exists := previous[pid]
		if !exists || prior.started != counters.started || counters.ticks < prior.ticks {
			continue
		}
		percent := min(100, float64(counters.ticks-prior.ticks)/float64(totalDelta)*100)
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
