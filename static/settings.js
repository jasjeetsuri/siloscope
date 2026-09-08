"use strict";

(() => {
  const model = MonitorPreferences;
  let storage;
  try { storage = window.localStorage; } catch {}
  let preferences = model.load(storage);
  let activeGroup = null;
  const menu = document.getElementById("settings-menu");
  const editor = document.getElementById("settings-editor");
  const options = document.getElementById("settings-options");
  const status = document.getElementById("settings-status");
  const visibilityStyles = document.querySelector('link[href="/styles.css"]').sheet;
  const firstVisibilityRule = visibilityStyles.cssRules.length;
  let visibilityRuleCount = 0;
  const panels = Object.fromEntries(model.systemOrder.map(key => [key, document.querySelector(model.groups.system.options.find(option => option[0] === key)[2])]));
  const grid = document.querySelector(".metric-grid");

  function make(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function apply() {
    const rules = [];
    for (const [group, definition] of Object.entries(model.groups)) {
      for (const [key, , selector] of definition.options) {
        if (!model.enabled(preferences, group, key)) rules.push(`${selector} { display: none !important; }`);
      }
    }
    if (!model.enabled(preferences, "playing", "posters")) rules.push(".session-card { grid-template-columns: minmax(0, 1fr); }");
    while (visibilityRuleCount > 0) {
      visibilityStyles.deleteRule(firstVisibilityRule);
      visibilityRuleCount--;
    }
    for (const rule of rules) {
      visibilityStyles.insertRule(rule, firstVisibilityRule + visibilityRuleCount);
      visibilityRuleCount++;
    }
    for (const key of preferences.systemOrder) grid.append(panels[key]);
    document.documentElement.style.setProperty("--chart-height", `${preferences.chartHeight}px`);
    window.dispatchEvent(new CustomEvent("monitor-settings-change", { detail: { chartMinutes: preferences.chartMinutes } }));
  }

  function commit() {
    apply();
    status.textContent = model.save(storage, preferences) ? "Saved on this device" : "Storage unavailable. Changes last until this page closes.";
  }

  function updateDisabled() {
    for (const input of options.querySelectorAll("input[data-key]")) {
      const option = model.groups[activeGroup].options.find(option => option[0] === input.dataset.key);
      input.disabled = !!option[3] && !model.enabled(preferences, activeGroup, option[3]);
    }
  }

  function renderOptions(focusKey) {
    options.replaceChildren();
    const definition = model.groups[activeGroup];
    if (activeGroup === "system") {
      const order = make("fieldset", "settings-fieldset");
      order.append(make("legend", "", "Item order"));
      preferences.systemOrder.forEach((key, index) => {
        const label = definition.options.find(option => option[0] === key)[1];
        const row = make("div", "settings-order-row");
        row.append(make("span", "", label));
        for (const [direction, delta, symbol] of [["up", -1, "\u2191"], ["down", 1, "\u2193"]]) {
          const button = make("button", "icon-button", symbol);
          button.type = "button";
          button.title = `Move ${label} ${direction}`;
          button.setAttribute("aria-label", button.title);
          button.dataset.order = `${key}-${direction}`;
          button.disabled = index + delta < 0 || index + delta >= preferences.systemOrder.length;
          button.addEventListener("click", () => {
            const target = index + delta;
            [preferences.systemOrder[index], preferences.systemOrder[target]] = [preferences.systemOrder[target], preferences.systemOrder[index]];
            commit();
            renderOptions(`${key}-${target === 0 ? "down" : target === preferences.systemOrder.length - 1 ? "up" : direction}`);
          });
          row.append(button);
        }
        order.append(row);
      });
      options.append(order);
      const heightLabel = make("label", "settings-height");
      const height = make("input", "");
      height.type = "range";
      height.min = "100";
      height.max = "220";
      height.step = "10";
      height.value = preferences.chartHeight;
      const output = make("output", "", `${preferences.chartHeight}px`);
      height.setAttribute("aria-label", "Graph height");
      height.addEventListener("input", () => {
        preferences.chartHeight = Number(height.value);
        output.textContent = `${height.value}px`;
        commit();
      });
      heightLabel.append(make("span", "", "Graph height"), output, height);
      options.append(heightLabel);
      const durationLabel = make("label", "settings-duration");
      const duration = make("select", "");
      duration.setAttribute("aria-label", "Graph time window");
      for (const minutes of [2, 3, 4, 5]) {
        const option = make("option", "", `${minutes} minutes`);
        option.value = String(minutes);
        duration.append(option);
      }
      duration.value = String(preferences.chartMinutes);
      duration.addEventListener("change", () => {
        preferences.chartMinutes = Number(duration.value);
        commit();
      });
      durationLabel.append(make("span", "", "Graph time window"), duration);
      options.append(durationLabel);
    }
    const fields = make("fieldset", "settings-fieldset");
    fields.append(make("legend", "", "Visibility"));
    for (const [key, label, , parent] of definition.options) {
      const row = make("label", `settings-toggle${parent ? " settings-child" : ""}`);
      const input = make("input", "");
      input.type = "checkbox";
      input.dataset.key = key;
      input.checked = preferences.visibility[`${activeGroup}.${key}`];
      input.addEventListener("change", () => {
        preferences.visibility[`${activeGroup}.${key}`] = input.checked;
        commit();
        updateDisabled();
      });
      row.append(make("span", "", label), input);
      fields.append(row);
    }
    options.append(fields);
    updateDisabled();
    if (focusKey) options.querySelector(`[data-order="${focusKey}"]`)?.focus();
  }

  for (const [key, definition] of Object.entries({ ...model.groups, transcoder: { label: "Transcoder" } })) {
    const button = make("button", "settings-menu-item");
    button.type = "button";
    const arrow = make("span", "", "\u203a");
    arrow.setAttribute("aria-hidden", "true");
    button.append(make("span", "", definition.label), arrow);
    button.dataset.group = key;
    button.addEventListener("click", () => {
      activeGroup = key;
      menu.hidden = true;
      editor.hidden = false;
      const heading = document.getElementById("settings-group-heading");
      heading.textContent = definition.label;
      document.getElementById("reset-tab-settings").hidden = key === "transcoder";
      document.getElementById("reset-settings").hidden = key === "transcoder";
      if (key === "transcoder") TranscoderSettings.open(options, status);
      else renderOptions();
      heading.focus();
    });
    menu.append(button);
  }
  document.getElementById("settings-back").addEventListener("click", () => {
    if (activeGroup === "transcoder") {
      if (!TranscoderSettings.canLeave()) return;
      TranscoderSettings.leave();
      status.textContent = "";
    }
    editor.hidden = true;
    menu.hidden = false;
    menu.querySelector(`[data-group="${activeGroup}"]`).focus();
    activeGroup = null;
    document.getElementById("reset-settings").hidden = false;
  });
  document.getElementById("reset-settings").addEventListener("click", () => {
    preferences = model.normalize(null);
    commit();
    if (activeGroup && activeGroup !== "transcoder") renderOptions();
  });
  document.getElementById("reset-tab-settings").addEventListener("click", () => {
    if (!activeGroup || activeGroup === "transcoder") return;
    for (const [key] of model.groups[activeGroup].options) preferences.visibility[`${activeGroup}.${key}`] = true;
    if (activeGroup === "system") {
      preferences.systemOrder = [...model.systemOrder];
      preferences.chartHeight = 140;
      preferences.chartMinutes = 5;
    }
    commit();
    renderOptions();
  });
  window.addEventListener("storage", event => {
    if (event.key !== model.storageKey && event.key !== null) return;
    preferences = model.load(storage);
    apply();
    if (activeGroup && activeGroup !== "transcoder") renderOptions();
  });
  apply();
})();