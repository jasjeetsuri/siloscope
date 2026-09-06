package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestProcessSampler(t *testing.T) {
	directory := t.TempDir()
	write := func(path, value string) {
		t.Helper()
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	writeProcess := func(pid, ticks, started int) {
		t.Helper()
		path := filepath.Join(directory, fmt.Sprint(pid))
		if err := os.MkdirAll(path, 0700); err != nil {
			t.Fatal(err)
		}
		fields := strings.Fields("R 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0")
		fields[11], fields[19] = fmt.Sprint(ticks), fmt.Sprint(started)
		write(filepath.Join(path, "stat"), fmt.Sprintf("%d (worker (cpu)) %s", pid, strings.Join(fields, " ")))
	}
	write(filepath.Join(directory, "stat"), "cpu 100 0 0 900 0 0 0 0 999 999\n")
	for pid := 1; pid <= 5; pid++ {
		writeProcess(pid, 10, 1)
	}
	sampler := &processSampler{procDir: directory}
	sampler.sample(time.Now())
	if sampler.latest.Available {
		t.Fatal("first sample should be unavailable")
	}
	write(filepath.Join(directory, "stat"), "cpu 200 0 0 900 0 0 0 0 1999 1999\n")
	for pid := 1; pid <= 4; pid++ {
		writeProcess(pid, 10+pid*5, 1)
	}
	writeProcess(5, 1000, 2)
	sampler.sample(time.Now())
	if !sampler.latest.Available || len(sampler.latest.Processes) != 3 {
		t.Fatalf("unexpected snapshot: %+v", sampler.latest)
	}
	if top := sampler.latest.Processes[0]; top.PID != 4 || top.Percent != 20 || top.Name != "worker (cpu)" {
		t.Fatalf("unexpected top process: %+v", top)
	}
	write(filepath.Join(directory, "stat"), "invalid")
	sampler.sample(time.Now())
	if sampler.latest.Available || len(sampler.latest.Processes) != 0 {
		t.Fatal("stale processes not cleared")
	}
}

func TestProcessTicksRejectMalformed(t *testing.T) {
	for _, raw := range []string{"", "1 missing name", "1 (name) R 0"} {
		if _, err := parseProcessTicks(raw); err == nil {
			t.Fatalf("accepted %q", raw)
		}
	}
}
