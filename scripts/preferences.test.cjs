const { test } = require("node:test");
const assert = require("node:assert/strict");
const preferences = require("../static/preferences.js");

test("defaults show all existing content", () => {
  const value = preferences.normalize(null);
  assert.ok(Object.values(value.visibility).every(Boolean));
  assert.equal(value.chartHeight, 140);
  assert.deepEqual(value.systemOrder, ["disk", "cpu", "network", "memory"]);
});

test("saved values are bounded and order is repaired", () => {
  const value = preferences.normalize({ visibility: { "system.cpu": false, "playing.cards": "false" }, systemOrder: ["memory", "memory", "bad"], chartHeight: 999 });
  assert.equal(value.visibility["system.cpu"], false);
  assert.equal(value.visibility["playing.cards"], true);
  assert.deepEqual(value.systemOrder, ["memory", "disk", "cpu", "network"]);
  assert.equal(value.chartHeight, 220);
});

test("hidden parents suppress children without changing saved child values", () => {
  const value = preferences.normalize({ visibility: { "system.cpu": false } });
  assert.equal(preferences.enabled(value, "system", "cpu.processes"), false);
  assert.equal(value.visibility["system.cpu.processes"], true);
  value.visibility["system.cpu"] = true;
  assert.equal(preferences.enabled(value, "system", "cpu.processes"), true);
});

test("storage failures and corrupt JSON fall back safely", () => {
  assert.deepEqual(preferences.load({ getItem() { return "{"; } }), preferences.normalize(null));
  assert.deepEqual(preferences.load({ getItem() { throw Error("blocked"); } }), preferences.normalize(null));
  assert.equal(preferences.save({ setItem() { throw Error("blocked"); } }, preferences.normalize(null)), false);
});

test("preferences round trip", () => {
  let stored;
  const storage = { getItem: () => stored, setItem: (_, value) => { stored = value; } };
  const value = preferences.normalize({ visibility: { "system.cpu.processes": false }, systemOrder: ["cpu", "memory", "disk", "network"] });
  assert.equal(preferences.save(storage, value), true);
  assert.deepEqual(preferences.load(storage), value);
});