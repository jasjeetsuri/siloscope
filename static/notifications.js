"use strict";

const NotificationSettings = (() => {
  let generation = 0;
  let pending = false;
  let flushSave = () => true;
  let pendingOperation = Promise.resolve(true);

  function node(tag, className, text) {
    const element = document.createElement(tag);
    element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function subscriptionData(subscription) {
    const { endpoint, keys } = subscription.toJSON();
    return { endpoint, keys };
  }

  async function api(action, subscription, rules) {
    const response = await fetch("/api/notifications", action ? {
      method: "POST",
      signal: AbortSignal.timeout(15000),
      headers: { "Content-Type": "application/json", "X-Siloscope-Settings": "1" },
      body: JSON.stringify({ action, subscription: subscriptionData(subscription), ...(rules ? { rules } : {}) }),
    } : { cache: "no-store", signal: AbortSignal.timeout(15000) });
    let payload;
    try { payload = await response.json(); } catch { throw new Error("Notification server is unavailable."); }
    if (!response.ok) {
      const error = new Error(payload.error || "Notification request failed.");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function applicationKey(value) {
    const padded = value + "=".repeat((4 - value.length % 4) % 4);
    return Uint8Array.from(atob(padded.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
  }

  async function open(container, status) {
    const current = ++generation;
    pending = false;
    flushSave = () => true;
    container.replaceChildren();
    status.textContent = "Loading notification settings...";
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (ios && !matchMedia("(display-mode: standalone)").matches && !navigator.standalone) {
      status.textContent = "Notifications are available from the iOS Home Screen app.";
      return;
    }
    if (!window.isSecureContext || !("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      status.textContent = "Push notifications are unavailable in this browser.";
      return;
    }
    try {
      const config = await api();
      if (current !== generation) return;
      if (!config.enabled) { status.textContent = "Push notifications are not configured on this server."; return; }
      const registration = await navigator.serviceWorker.register("/notification-worker.js", { scope: "/", updateViaCache: "none" });
      await navigator.serviceWorker.ready;
      let subscription = await registration.pushManager.getSubscription();
      let registered = false;
      let rules = config.defaults;
      if (subscription) {
        try { rules = (await api("get", subscription)).rules; registered = true; }
        catch (error) { if (error.status !== 404) throw error; }
      }
      if (current !== generation) return;
      const form = node("form", "notification-settings");
      const actions = node("div", "notification-actions");
      const enable = node("button", "restart-now", "Enable notifications");
      const disable = node("button", "restart-now", "Disable notifications");
      const test = node("button", "restart-now", "Send test");
      for (const button of [enable, disable, test]) button.type = "button";
      actions.append(enable, disable, test);
      const inputs = {};
      const outputs = {};
      const headings = { cpu: "CPU Alerts", disk: "Disk Alerts", playback: "Playback Alerts" };
      let fields;
      form.append(actions);
      for (const [key, label, type, minimum, maximum] of [
        ["cpu", "Sustained high CPU", "checkbox"],
        ["threshold", "Usage threshold", "range", 70, 100],
        ["minutes", "Sustained for", "range", 5, 15],
        ["cooldown", "Repeat cooldown", "range", 10, 60],
        ["recovery", "Recovery notification", "checkbox"],
        ["disk", "High disk usage", "checkbox"],
        ["disk_threshold", "Usage threshold", "range", 75, 100],
        ["playback", "Playback started", "checkbox"],
        ["transcode", "Transcoding started", "checkbox"],
        ["details", "Include titles and usernames", "checkbox"],
      ]) {
        if (headings[key]) {
          fields = node("fieldset", "settings-fieldset notification-group");
          const legend = node("legend", "");
          legend.append(node("h4", "notification-heading", headings[key]));
          fields.append(legend);
          form.append(fields);
        }
        const row = node("label", type === "checkbox" ? "settings-toggle" : "settings-height");
        const input = node("input", "");
        input.type = type;
        input.name = key;
        input.setAttribute("aria-label", label);
        if (type === "checkbox") input.checked = rules[key];
        else { input.min = minimum; input.max = maximum; input.step = 1; input.required = true; input.value = rules[key]; }
        inputs[key] = input;
        row.append(node("span", "", label));
        if (type === "range") {
          const output = node("output", "");
          const refresh = () => {
            output.textContent = `${input.value}${key.includes("threshold") ? "%" : " min"}`;
            input.setAttribute("aria-valuetext", output.textContent);
          };
          outputs[key] = refresh;
          input.addEventListener("input", refresh);
          refresh();
          row.append(output);
        }
        row.append(input);
        fields.append(row);
      }
      container.append(form);
      const readRules = () => Object.fromEntries(Object.entries(inputs).map(([key, input]) => [key, input.type === "checkbox" ? input.checked : Number(input.value)]));
      const update = () => {
        enable.hidden = registered;
        disable.hidden = !subscription;
        test.hidden = !registered;
        for (const control of [enable, disable, test, ...Object.values(inputs)]) control.disabled = pending;
        for (const key of ["threshold", "minutes", "cooldown", "recovery"]) inputs[key].disabled = pending || !inputs.cpu.checked;
        inputs.disk_threshold.disabled = pending || !inputs.disk.checked;
        if (Notification.permission === "denied") enable.disabled = true;
      };
      inputs.cpu.addEventListener("change", update);
      inputs.disk.addEventListener("change", update);
      const perform = action => {
        if (pending) return pendingOperation;
        pending = true;
        update();
        pendingOperation = (async () => {
          try { await action(); return true; }
          catch (error) {
            if (current === generation) status.textContent = error.message || "Notification request failed.";
            return false;
          }
          finally { pending = false; if (current === generation) update(); }
        })();
        return pendingOperation;
      };
      const persist = () => {
        if (pending) return pendingOperation;
        if (current !== generation || !registered || !form.checkValidity()) return true;
        const next = readRules();
        if (Object.keys(next).every(key => next[key] === rules[key])) return true;
        status.textContent = "Saving notification preferences...";
        return perform(async () => {
          try {
            rules = (await api("save", subscription, next)).rules;
            status.textContent = "Notification preferences saved.";
          } catch (error) {
            for (const [key, input] of Object.entries(inputs)) {
              if (input.type === "checkbox") input.checked = rules[key];
              else input.value = rules[key];
              outputs[key]?.();
            }
            throw error;
          }
        });
      };
      flushSave = persist;
      form.addEventListener("change", persist);
      enable.addEventListener("click", () => {
        if (!form.reportValidity()) return;
        perform(async () => {
          const permission = await Notification.requestPermission();
          if (permission !== "granted") throw new Error("Notification permission was not granted.");
          if (subscription) {
            if (!await subscription.unsubscribe()) throw new Error("The old browser subscription could not be removed.");
            subscription = null;
          }
          if (!subscription) subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(config.public_key) });
          rules = (await api("save", subscription, readRules())).rules;
          registered = true;
          status.textContent = "Notifications enabled on this device.";
        });
      });
      disable.addEventListener("click", () => perform(async () => {
        await api("delete", subscription);
        registered = false;
        if (!await subscription.unsubscribe()) throw new Error("Server alerts disabled. Browser subscription could not be removed; try again.");
        subscription = null;
        status.textContent = "Notifications disabled on this device.";
      }));
      test.addEventListener("click", () => perform(async () => {
        await api("test", subscription);
        status.textContent = "Test notification queued.";
      }));
      form.addEventListener("submit", event => {
        event.preventDefault();
        if (form.reportValidity()) persist();
      });
      status.textContent = Notification.permission === "denied" ? "Notifications are blocked in your device settings." : "";
      update();
    } catch (error) {
      if (current === generation) status.textContent = error.message || "Notification settings are unavailable.";
    }
  }

  const requestedView = new URLSearchParams(location.search).get("view");
  if (requestedView === "system" || requestedView === "playing") {
    document.querySelector(`[data-tab="${requestedView}"]`)?.click();
  }
  return { open, canLeave: async () => await flushSave() !== false, leave: () => { generation++; } };
})();