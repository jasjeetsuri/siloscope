const assert = require("node:assert/strict");
const { test } = require("node:test");
const { chromium } = require("playwright");

test("combined playback, source failures, preferences, and responsive layout", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    let siloFailed = false;
    let plexFailed = false;
    let plexEnabled = true;
    const siloSessions = [{
      id: "1", media_title: "Silo Movie", media_type: "movie", username: "Alex",
      play_method: "direct_play", client_name: "Living Room TV", file_duration: 7200,
      position_seconds: 1200, started_at: new Date().toISOString(), routing_execution_node_id: 1,
    }];
    const plexSessions = [{
      id: "plex:1", source: "plex", media_title: "Pilot", series_name: "Example Series",
      season_number: 1, episode_number: 2, episode_name: "Pilot", username: "Sam",
      play_method: "transcode", client_name: "Plex for Apple TV", is_paused: true,
      file_duration: 1800, position_seconds: 600, playback_state: "paused",
      poster_url: "/api/plex/poster?id=12", routing_execution_node_id: 1,
    }, {
      id: "plex:2", source: "plex", media_title: "A Very Long Song Title With Multiple Words",
      subtitle: "Artist / Album", media_type: "track", username: "Taylor",
      play_method: "audio", client_name: "Plexamp", file_duration: 240,
      position_seconds: 60, playback_state: "playing",
    }];
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/plex/poster") {
        await route.fulfill({ contentType: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aE1cAAAAASUVORK5CYII=", "base64") });
        return;
      }
      if ((path === "/api/sessions" && siloFailed) || (path === "/api/plex/sessions" && plexFailed)) {
        await route.fulfill({ status: 502, json: { error: "Unavailable" } });
        return;
      }
      const responses = {
        "/api/sessions": siloSessions,
        "/api/plex/sessions": { enabled: plexEnabled, sessions: plexEnabled ? plexSessions : [] },
        "/api/nodes": [],
        "/api/history": [],
        "/api/resources": { cpu_pct: 10, mem_pct: 20, disks: [] },
        "/api/processes": { available: false, processes: [] },
      };
      await route.fulfill({ json: responses[path] || {} });
    });
    await page.goto(process.env.MONITOR_TEST_URL || "http://127.0.0.1:18198");
    await page.waitForFunction(() => !state.sessionInFlight && state.sessions.length === 3);
    await page.evaluate(() => stopPolling());
    await page.locator('[data-tab="playing"]').click();
    assert.equal(await page.locator("#playing-badge").textContent(), "3");
    assert.equal(await page.locator(".session-source.source-plex").count(), 2);
    assert.equal(await page.locator(".session-card.paused .session-time").textContent(), "Paused");
    assert.equal(await page.evaluate(() => nodeRouteCount({ id: 1, type: "transcode" })), 1);
    assert.match(await page.locator(".session-card.paused .progress-fill").getAttribute("style"), /33\.33/);
    await page.waitForFunction(() => document.querySelector(".poster img")?.naturalWidth > 0);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow at ${width}px`);
      await page.screenshot({ path: `/tmp/silo-monitor-plex-${width}.png`, fullPage: true });
    }
    await page.evaluate(() => {
      const preferences = MonitorPreferences.normalize(null);
      preferences.visibility["playing.source"] = false;
      MonitorPreferences.save(localStorage, preferences);
    });
    await page.reload();
    await page.waitForFunction(() => !state.sessionInFlight && state.sessions.length === 3);
    await page.evaluate(() => stopPolling());
    await page.locator('[data-tab="playing"]').click();
    assert.equal(await page.locator(".session-source").first().isVisible(), false);
    plexFailed = true;
    await page.evaluate(() => refreshSessions());
    assert.equal(await page.locator(".session-card").count(), 1);
    assert.match(await page.locator("#session-message").textContent(), /Plex playback is unavailable/);
    assert.equal(await page.locator("#playing-badge").textContent(), "1");
    siloFailed = true;
    plexFailed = false;
    await page.evaluate(() => refreshSessions());
    assert.equal(await page.locator(".session-card").count(), 2);
    assert.match(await page.locator("#session-message").textContent(), /Silo playback is unavailable/);
    plexFailed = true;
    await page.evaluate(() => refreshSessions());
    assert.equal(await page.locator(".session-card").count(), 0);
    assert.match(await page.locator("#sessions").textContent(), /Playback status incomplete/);
    assert.equal(await page.locator("#playing-badge").isVisible(), false);
    siloFailed = false;
    plexFailed = false;
    plexEnabled = false;
    await page.evaluate(() => refreshSessions());
    assert.equal(await page.locator(".session-card").count(), 1);
    assert.equal(await page.locator("#session-message").isVisible(), false);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});