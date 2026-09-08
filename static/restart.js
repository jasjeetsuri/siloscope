"use strict";

(() => {
  const section = document.querySelector('[data-view="settings"]');
  const banner = document.getElementById("settings-restart-banner");
  const title = document.getElementById("settings-restart-title");
  const message = document.getElementById("settings-restart-message");
  const button = document.getElementById("settings-restart-now");
  const buttonLabel = document.getElementById("settings-restart-button-label");
  let pending = false;
  let preview = false;
  let version = 0;
  let inFlight = false;
  let timer;
  let restarting = false;
  let startedAt = "";
  let restartStartedAt = "";
  let restartBegan = 0;
  let failure = "";
  const visible = () => !section.hidden && !document.hidden;

  function render(unavailable = false) {
    banner.hidden = !pending && !restarting;
    button.disabled = restarting;
    buttonLabel.textContent = restarting ? "Restarting..." : "Restart now";
    title.textContent = preview ? "Restart required (preview)" : "Silo restart required";
    message.textContent = unavailable ? "Restart status is temporarily unavailable. The last known state still requires a restart." : preview ? "Preview settings are pending a restart. Live Silo is unchanged." : "Some saved settings will take effect after Silo is restarted.";
    if (restarting) {
      title.textContent = preview ? "Restarting preview" : "Waiting for Silo to restart";
      message.textContent = "Waiting for the server to come back online.";
    }
    if (failure) message.textContent = failure;
  }

  async function refresh() {
    clearTimeout(timer);
    if (!visible() || inFlight) return;
    inFlight = true;
    const requestedVersion = version;
    try {
      const response = await fetch("/api/restart-status", { cache: "no-store", signal: AbortSignal.timeout(10000) });
      const result = await response.json();
      if (!response.ok || typeof result.restart_required !== "boolean") throw new Error("Restart status unavailable");
      if (requestedVersion !== version) return;
      if (restarting && restartStartedAt && result.started_at !== restartStartedAt) {
        restarting = false;
        failure = "";
      }
      if (!restarting && result.restart_requested && !failure) {
        restarting = true;
        restartStartedAt = result.started_at;
        restartBegan = Date.now();
      }
      startedAt = result.started_at;
      if (restarting && !restartStartedAt) restartStartedAt = startedAt;
      pending = result.restart_required;
      preview = result.preview === true;
      render();
    } catch {
      if (requestedVersion === version) render(true);
    } finally {
      inFlight = false;
      if (restarting && Date.now() - restartBegan > 120000) {
        restarting = false;
        pending = true;
        failure = "Restart completion could not be confirmed. Check Silo before retrying.";
        render();
      }
      if (visible()) timer = setTimeout(refresh, restarting ? 3000 : 15000);
    }
  }

  button.addEventListener("click", async () => {
    if (restarting) return;
    if (window.TranscoderSettings?.canRestart() === false) {
      failure = "Wait for settings to finish saving, or correct invalid values, before restarting.";
      render();
      return;
    }
    if (!window.confirm(preview ? "Simulate a restart in the local preview? Live Silo will not restart." : "Restart Silo now? Active playback may be interrupted while the server restarts.")) return;
    version++;
    restarting = true;
    restartStartedAt = startedAt;
    restartBegan = Date.now();
    failure = "";
    clearTimeout(timer);
    render();
    try {
      const response = await fetch("/api/restart", { method: "POST", headers: { "Content-Type": "application/json", "X-Siloscope-Settings": "1" }, body: "{}", signal: AbortSignal.timeout(10000) });
      if ([400, 403, 503].includes(response.status)) {
        restarting = false;
        failure = "Silo rejected the restart request or restart is unavailable.";
      } else if (response.status !== 202) {
        failure = "Restart request could not be confirmed. Checking server status...";
      }
    } catch {
      failure = "Restart request could not be confirmed. Checking server status...";
    }
    render();
    refresh();
  });

  window.addEventListener("monitor-restart-required", event => {
    version++;
    pending = true;
    preview = event.detail?.preview === true;
    render();
  });
  window.addEventListener("monitor-view-change", refresh);
  document.addEventListener("visibilitychange", refresh);
  refresh();
})();