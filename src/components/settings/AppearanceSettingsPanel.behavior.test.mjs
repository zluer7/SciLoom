import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { build } from "esbuild";
import React from "react";
import TestRenderer, { act } from "react-test-renderer";

const bundle = await build({
  stdin: { contents: `export * from './src/services/appearancePreference.ts';
    export * from './src/components/layout/AppearanceProvider.tsx';
    export * from './src/components/settings/AppearanceSettingsPanel.tsx';
    export * from './src/components/settings/SettingsPreferenceRow.tsx';
    export { getDataSourceMode, projectDataSourceMode } from './src/repositories/dataSourceMode.ts';
    export { I18nProvider } from './src/i18n/I18nProvider.tsx';`, resolveDir: resolve(".") },
  bundle: true, write: false, platform: "node", format: "cjs", jsx: "automatic",
  external: ["react", "react/jsx-runtime"]
});
const module = { exports: {} };
new Function("require", "module", "exports", bundle.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const subject = module.exports;
let mounted;
function browser(stored = null) {
  const rows = new Map([["researchpilot.language", "en-US"]]);
  if (stored !== null) rows.set(subject.APPEARANCE_PREFERENCE_KEY, stored);
  const state = { rows, writes: [], listeners: new Set(), failWrite: false, failRead: false, loseWrite: false };
  const query = { matches: false, addEventListener: (_, listener) => state.listeners.add(listener), removeEventListener: (_, listener) => state.listeners.delete(listener) };
  state.storage = {
    getItem: key => { if (state.failRead && key === subject.APPEARANCE_PREFERENCE_KEY) throw Error("read unavailable"); return rows.get(key) ?? null; },
    setItem: (key, value) => { if (state.failWrite) throw Error("quota"); state.writes.push([key, value]); if (!state.loseWrite) rows.set(key, value); }
  };
  state.scheme = dark => { query.matches = dark; state.listeners.forEach(listener => listener({ matches: dark })); };
  globalThis.window = { localStorage: state.storage, matchMedia: () => query };
  globalThis.document = { documentElement: { dataset: {} } };
  return state;
}
function mount() {
  act(() => { mounted = TestRenderer.create(React.createElement(subject.I18nProvider, null,
    React.createElement(subject.AppearanceProvider, null, React.createElement(subject.AppearanceSettingsPanel)))); });
}
function choose(value) { act(() => mounted.root.findByType("select").props.onChange({ target: { value } })); }
function selected() { return mounted.root.findByType("select").props.value; }
function cleanup() { if (mounted) act(() => mounted.unmount()); mounted = undefined; }
test.afterEach(cleanup);

test("Settings first row preserves theme and language authorities through switching and remount", () => {
  const state = browser();
  const mountRow = () => act(() => { mounted = TestRenderer.create(React.createElement(subject.I18nProvider, null,
    React.createElement(subject.AppearanceProvider, null, React.createElement(subject.SettingsPreferenceRow)))); });
  mountRow();
  const row = mounted.root.findByProps({ className: "settings-preference-row" });
  assert.equal(row.children.length, 3);
  assert.equal(mounted.root.findByProps({ className: "settings-preference-row__reserved" }).props["aria-hidden"], "true");
  for (const mode of ["LIGHT", "DARK", "SYSTEM"]) {
    act(() => mounted.root.findByProps({ id: "appearance-preference" }).props.onChange({ target: { value: mode } }));
    for (const lang of ["zh-CN", "en-US"]) {
      act(() => mounted.root.findByProps({ id: "settings-language-preference" }).props.onChange({ target: { value: lang } }));
      assert.equal(state.rows.get("researchpilot.language"), lang);
      assert.equal(subject.readAppearancePreference(), mode);
      cleanup(); mountRow();
      assert.equal(mounted.root.findByProps({ id: "appearance-preference" }).props.value, mode);
      assert.equal(mounted.root.findByProps({ id: "settings-language-preference" }).props.value, lang);
    }
  }
  assert.deepEqual([...new Set(state.writes.map(([key]) => key))].sort(), [subject.APPEARANCE_PREFERENCE_KEY, "researchpilot.language"].sort());
});

test("missing/corrupt/unavailable preference and missing system API safely initialize without writes", () => {
  for (const value of [null, "garbage", '{"mode":"dark"}']) {
    const state = browser(value); subject.initializeAppearance();
    assert.equal(document.documentElement.dataset.appearance, "SYSTEM");
    assert.equal(document.documentElement.dataset.theme, "light");
    assert.deepEqual(state.writes, []);
    if (value !== null) assert.equal(state.rows.get(subject.APPEARANCE_PREFERENCE_KEY), value);
  }
  const state = browser("DARK"); state.failRead = true; window.matchMedia = undefined;
  subject.initializeAppearance(); mount();
  assert.equal(selected(), "SYSTEM"); assert.equal(document.documentElement.dataset.theme, "light");
  assert.deepEqual(state.writes, []);
});

test("each intent writes only its key, fresh reconstruction restores it and SYSTEM stays intent", () => {
  const state = browser(); mount();
  for (const value of ["DARK", "LIGHT", "SYSTEM"]) {
    choose(value); assert.equal(selected(), value);
    assert.equal(subject.readAppearancePreference(), value);
    cleanup(); subject.initializeAppearance(); mount(); assert.equal(selected(), value);
  }
  act(() => state.scheme(true));
  assert.equal(selected(), "SYSTEM"); assert.equal(document.documentElement.dataset.theme, "dark");
  assert.equal(state.rows.get(subject.APPEARANCE_PREFERENCE_KEY), "SYSTEM");
  assert.deepEqual(state.writes.map(([key]) => key), Array(3).fill(subject.APPEARANCE_PREFERENCE_KEY));
  assert.equal(state.rows.get("researchpilot.language"), "en-US");
});

test("official query events follow SYSTEM, both explicit overrides hold, return applies current and listeners clean up", () => {
  const state = browser(); mount(); assert.equal(state.listeners.size, 1);
  act(() => state.scheme(true)); assert.equal(document.documentElement.dataset.theme, "dark");
  choose("LIGHT"); act(() => state.scheme(false)); act(() => state.scheme(true));
  assert.equal(document.documentElement.dataset.theme, "light");
  choose("DARK"); act(() => state.scheme(false)); assert.equal(document.documentElement.dataset.theme, "dark");
  choose("SYSTEM"); assert.equal(document.documentElement.dataset.theme, "light");
  cleanup(); assert.equal(state.listeners.size, 0); mount(); assert.equal(state.listeners.size, 1);
  assert.equal(state.writes.length, 3);
});

test("consecutive choices settle in order; failed write/readback cannot roll back a subsequent success", () => {
  const state = browser("LIGHT"); mount();
  choose("DARK"); state.failWrite = true; choose("LIGHT");
  assert.equal(selected(), "DARK"); assert.equal(document.documentElement.dataset.theme, "dark");
  assert.ok(mounted.root.findByProps({ role: "alert" }));
  state.failWrite = false; choose("SYSTEM");
  assert.equal(selected(), "SYSTEM"); assert.equal(subject.readAppearancePreference(), "SYSTEM");
  assert.equal(mounted.root.findAllByProps({ role: "alert" }).length, 0);
  state.failRead = true; choose("DARK"); // Write committed but verification unavailable: no success claim.
  assert.equal(selected(), "SYSTEM"); assert.equal(state.rows.get(subject.APPEARANCE_PREFERENCE_KEY), "DARK");
  assert.ok(mounted.root.findByProps({ role: "alert" }));
  state.failRead = false; choose("LIGHT");
  assert.equal(selected(), "LIGHT"); assert.equal(subject.readAppearancePreference(), "LIGHT");
  cleanup(); mount(); assert.equal(selected(), "LIGHT");
});

test("a silently lost write fails readback and preserves the last confirmed choice", () => {
  const state = browser("LIGHT"); mount(); state.loseWrite = true; choose("DARK");
  assert.equal(selected(), "LIGHT"); assert.equal(subject.readAppearancePreference(), "LIGHT");
  assert.ok(mounted.root.findByProps({ role: "alert" }));
});

test("denied storage access still mounts the shared preference roots and keeps automatic native authority", () => {
  browser("DARK");
  Object.defineProperty(window, "localStorage", { get() { throw Error("SecurityError: storage unavailable"); } });
  subject.initializeAppearance(); mount();
  assert.equal(selected(), "SYSTEM");
  assert.equal(document.documentElement.dataset.theme, "light");
  assert.equal(subject.getDataSourceMode(), "auto");
  assert.equal(subject.projectDataSourceMode(subject.getDataSourceMode(), true).effectiveMode, "sqlite");
  choose("DARK"); assert.equal(selected(), "SYSTEM"); assert.ok(mounted.root.findByProps({ role: "alert" }));
});

test("changing appearance preserves mounted child state and does not rerun initialization", () => {
  browser(); let initCount = 0;
  function Draft() {
    const [draft, setDraft] = React.useState(() => { initCount++; return ""; });
    return React.createElement("input", { value: draft, onChange: event => setDraft(event.target.value) });
  }
  act(() => { mounted = TestRenderer.create(React.createElement(subject.I18nProvider, null,
    React.createElement(subject.AppearanceProvider, null, React.createElement(subject.AppearanceSettingsPanel), React.createElement(Draft)))); });
  act(() => mounted.root.findByType("input").props.onChange({ target: { value: "User draft Ω" } }));
  for (const preference of ["DARK", "LIGHT", "SYSTEM"]) choose(preference);
  assert.equal(mounted.root.findByType("input").props.value, "User draft Ω"); assert.equal(initCount, 1);
});
