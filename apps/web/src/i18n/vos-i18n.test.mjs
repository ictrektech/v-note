import { expect, test } from "bun:test";

test("follows VOS until an explicit language is chosen, and resumes when reset", async () => {
  const values = new Map();
  let handler;
  const host = {
    parent: {},
    localStorage: {
      get length() { return values.size; },
      key: (index) => [...values.keys()][index] ?? null,
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => values.set(key, value),
      removeItem: (key) => values.delete(key),
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    vos_platform: {
      getState: async () => ({ locale: "zh-CN" }),
      broadcast: { on: (_event, listener) => { handler = listener; return () => {}; } },
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: host });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: {} } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { languages: ["en-US"], language: "en-US" } });
  const { default: i18n, bootstrapI18n, changeAppLocalePreference } = await import("./index.ts");
  const waitForLanguage = async (locale) => {
    for (let attempt = 0; attempt < 100 && i18n.language !== locale; attempt += 1) await Bun.sleep(10);
    expect(i18n.language).toBe(locale);
  };
  await bootstrapI18n();
  await waitForLanguage("zh-CN");
  handler({ locale: "en-US" });
  await waitForLanguage("en-US");
  await changeAppLocalePreference("zh-CN");
  handler({ locale: "en-US" });
  await Bun.sleep(10);
  expect(i18n.language).toBe("zh-CN");
  await changeAppLocalePreference("system");
  expect(i18n.language).toBe("en-US");
});
