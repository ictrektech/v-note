import { afterEach, describe, expect, test } from "bun:test";
import { listenForVosLocale, readVosLocale } from "./vos-locale.ts";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const makeWindow = (bridge, entries = {}) => {
  const listeners = new Map();
  const values = new Map(Object.entries(entries));
  const host = {
    vos_platform: bridge,
    parent: {},
    localStorage: {
      length: values.size,
      key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(key) ?? null,
    },
    addEventListener: (name, handler) => listeners.set(name, handler),
    removeEventListener: (name) => listeners.delete(name),
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: host });
  return host;
};

describe("VOS language following", () => {
  test("uses legacy platform preference when the bridge is unavailable", () => {
    makeWindow(undefined, { "VIVIBIT-5.5.9-prod-preferences-locale": '{"value":"zh-CN"}' });
    expect(readVosLocale()).toBe("zh-CN");
  });

  test("applies bridge changes and prevents an older snapshot from overwriting them", async () => {
    let handler;
    let resolveSnapshot;
    let unsubscribed = false;
    const snapshot = new Promise((resolve) => { resolveSnapshot = resolve; });
    makeWindow({
      getState: () => snapshot,
      broadcast: { on: (_event, listener) => { handler = listener; return () => { unsubscribed = true; }; } },
    }, { "preferences-locale": '"en-US"' });
    const applied = [];
    const stop = listenForVosLocale((locale) => applied.push(locale));
    handler({ locale: "zh-CN" });
    resolveSnapshot({ locale: "en-US" });
    await Promise.resolve();
    expect(applied).toEqual(["en-US", "zh-CN"]);
    handler({ locale: "en-US" });
    expect(applied.at(-1)).toBe("en-US");
    stop();
    expect(unsubscribed).toBe(true);
  });
});
