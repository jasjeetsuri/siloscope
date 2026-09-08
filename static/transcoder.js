"use strict";

window.TranscoderSettings = (() => {
  let generation = 0;
  let dirty = false;
  let saving = false;
  let saveTimer;

  function canLeave() {
    return !saving;
  }

  function leave() {
    generation++;
    clearTimeout(saveTimer);
    dirty = false;
  }

  function make(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function open(container, status) {
    clearTimeout(saveTimer);
    const current = ++generation;
    dirty = false;
    container.replaceChildren();
    status.textContent = "Loading Silo transcoder settings...";
    try {
      const response = await fetch("/api/transcoder", { cache: "no-store", signal: AbortSignal.timeout(15000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Unable to load transcoder settings");
      if (!Array.isArray(data.fields) || !data.values || !Array.isArray(data.restart_keys)) throw new Error("Invalid transcoder settings response");
      if (current !== generation) return;
      const original = { ...data.values };
      const inputs = new Map();
      const form = make("form", "transcoder-form");
      if (data.preview) container.append(make("p", "settings-status", "Local preview. Changes do not affect the live Silo server."));
      const groups = new Map();
      const restartKeys = new Set(data.restart_keys);
      for (const field of data.fields) {
        if (!groups.has(field.group)) {
          const group = make("fieldset", "settings-fieldset");
          group.append(make("legend", "", field.group));
          groups.set(field.group, group);
          form.append(group);
        }
        const row = make("label", "transcoder-field");
        const label = make("span", "transcoder-label", field.label);
        const supported = typeof original[field.key] === "string";
        if (!supported) label.append(make("small", "", "Unavailable on this Silo version"));
        else if (restartKeys.has(field.key)) label.append(make("small", "transcoder-restart-label", "Requires Silo restart"));
        const input = make(field.type === "select" ? "select" : "input", "");
        input.setAttribute("aria-label", field.label);
        input.name = field.key;
        input.disabled = !supported;
        if (field.type === "select") {
          for (const [value, text] of field.options) {
            const option = make("option", "", text);
            option.value = value;
            input.append(option);
          }
          if (supported && !field.options.some(([value]) => value === original[field.key])) {
            const option = make("option", "", original[field.key]);
            option.value = original[field.key];
            input.append(option);
          }
        } else {
          input.type = field.type === "boolean" ? "checkbox" : field.type;
          if (field.type === "number") { input.min = String(field.min ?? 0); input.step = "1"; input.required = true; }
          if (field.type === "text") { input.maxLength = 4096; input.placeholder = field.placeholder || ""; }
        }
        if (field.type === "boolean") input.checked = original[field.key] === "true";
        else input.value = original[field.key] ?? "";
        const feedback = make("small", "transcoder-feedback");
        feedback.setAttribute("role", "status");
        label.append(feedback);
        inputs.set(field.key, { input, field, supported, feedback });
        row.append(label, input);
        groups.get(field.group).append(row);
      }
      let uncertain = false;
      const valueOf = ({ input, field }) => field.type === "boolean" ? String(input.checked) : input.value;
      function changes() {
        return Object.fromEntries([...inputs].filter(([key, entry]) => entry.supported && valueOf(entry) !== original[key]).map(([key, entry]) => [key, valueOf(entry)]));
      }
      function update() {
        dirty = Object.keys(changes()).length > 0;
        for (const { input, field, supported } of inputs.values()) {
          input.disabled = saving || uncertain || !supported;
          if (field.key === "playback.segment_retention_seconds") {
            const value = Number(input.value);
            input.setCustomValidity(value > 0 && value < 120 ? "Use 0 or at least 120 seconds." : "");
          }
        }
      }
      function restore() {
        for (const [key, { input, field }] of inputs) {
          if (field.type === "boolean") input.checked = original[key] === "true";
          else input.value = original[key] ?? "";
        }
      }
      async function persist() {
        clearTimeout(saveTimer);
        if (current !== generation || saving || uncertain) return;
        update();
        if (!dirty || !form.checkValidity()) return;
        const values = changes();
        const changed = Object.keys(values).map(key => inputs.get(key));
        for (const { feedback } of changed) feedback.textContent = "Saving...";
        saving = true;
        update();
        status.textContent = data.preview ? "Saving in local preview..." : "Saving to Silo...";
        let rejected = false;
        try {
          const response = await fetch("/api/transcoder", {
            method: "PUT", headers: { "Content-Type": "application/json", "X-Siloscope-Settings": "1" },
            body: JSON.stringify({ values }), signal: AbortSignal.timeout(15000),
          });
          rejected = response.status === 400;
          const result = await response.json();
          if (!response.ok) throw new Error(result.error || "Settings save could not be confirmed. Reload before retrying.");
          if (!result.values || Object.keys(values).some(key => typeof result.values[key] !== "string")) throw new Error("Settings save could not be confirmed. Reload before retrying.");
          Object.assign(original, result.values);
          if (result.restart_required) window.dispatchEvent(new CustomEvent("monitor-restart-required", { detail: { preview: data.preview === true } }));
          restore();
          for (const { field, feedback } of changed) feedback.textContent = data.preview ? "Saved in preview" : result.restart_required_keys?.includes(field.key) ? "Saved. Silo restart required." : "Saved";
          status.textContent = data.preview ? "Saved in local preview. Live Silo unchanged." : result.restart_required ? "Saved. Silo restart required for some changes." : "Saved to Silo";
        } catch (error) {
          if (rejected) restore();
          else {
            uncertain = true;
            const reload = make("button", "settings-command", "Reload settings");
            reload.type = "button";
            reload.addEventListener("click", () => open(container, status));
            form.append(reload);
          }
          for (const { feedback } of changed) feedback.textContent = rejected ? "Not saved. Previous value restored." : "Save not confirmed. Reload settings.";
          status.textContent = error.message || "Settings save could not be confirmed. Reload before retrying.";
        } finally {
          saving = false;
          update();
        }
      }
      form.addEventListener("input", event => {
        update();
        clearTimeout(saveTimer);
        const entry = inputs.get(event.target.name);
        if (entry) entry.feedback.textContent = event.target.validity.valid ? "" : event.target.validationMessage;
        if (event.target.type === "number") saveTimer = setTimeout(persist, 500);
      });
      form.addEventListener("change", persist);
      form.addEventListener("submit", event => { event.preventDefault(); persist(); });
      update();
      container.append(form);
      status.textContent = "Silo server settings";
    } catch (error) {
      if (current !== generation) return;
      status.textContent = error.message || "Unable to load transcoder settings";
      const retry = make("button", "settings-command", "Retry");
      retry.type = "button";
      retry.addEventListener("click", () => open(container, status));
      container.append(retry);
    }
  }

  window.addEventListener("beforeunload", event => {
    if (dirty || saving) { event.preventDefault(); event.returnValue = ""; }
  });
  return { open, canLeave, leave, canRestart: () => !saving && !dirty };
})();