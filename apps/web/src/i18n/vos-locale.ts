import { normalizeLocale, type SupportedLocale } from "./locales";

const isVosLocaleKey = (key: string) => key === "preferences-locale"
  || (["VIVIBIT-", "vben-web-antd-"].some((prefix) => key.startsWith(prefix)) && key.endsWith("-preferences-locale"));

export const readVosLocale = (): SupportedLocale | null => {
  try {
    if (typeof window === "undefined" || window.parent === window) return null;
    const storage = window.localStorage;
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => Boolean(key) && isVosLocaleKey(key!))
      .sort((left, right) => right.localeCompare(left, undefined, { numeric: true }));
    for (const key of keys) {
      const raw = storage.getItem(key);
      let value: unknown = raw;
      try {
        const parsed: unknown = JSON.parse(raw ?? "null");
        value = parsed && typeof parsed === "object" && "value" in parsed ? parsed.value : parsed;
      } catch { /* Older VOS versions store a plain string. */ }
      const locale = typeof value === "string" ? normalizeLocale(value) : null;
      if (locale) return locale;
    }
  } catch { /* Storage can be unavailable in an embedded browser. */ }
  return null;
};

export const listenForVosLocale = (apply: (locale: SupportedLocale | null) => void) => {
  let active = true;
  let revision = 0;
  let bridgeLocale: SupportedLocale | null = null;
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const refresh = () => { if (active) apply(bridgeLocale ?? readVosLocale()); };
  const accept = (state: { locale?: unknown }) => {
    const locale = typeof state.locale === "string" ? normalizeLocale(state.locale) : null;
    if (active && locale) { bridgeLocale = locale; refresh(); }
  };
  const connect = () => {
    let bridge = window.vos_platform;
    if (!bridge) {
      try { bridge = window.parent.vos_platform; } catch { /* Parent may be cross-origin. */ }
    }
    if (!bridge?.getState && !bridge?.broadcast) return false;
    try {
      unsubscribe = bridge.broadcast?.on("locale-change", (state) => { revision += 1; accept(state); });
      const snapshotRevision = revision;
      void bridge.getState?.().then((state) => { if (revision === snapshotRevision) accept(state); }).catch(() => undefined);
    } catch { /* Older VOS bridges may not support these methods. */ }
    return true;
  };
  window.addEventListener("storage", refresh);
  window.addEventListener("focus", refresh);
  window.addEventListener("languagechange", refresh);
  refresh();
  const started = Date.now();
  if (!connect() && window.parent !== window) {
    timer = setInterval(() => { if (connect() || Date.now() - started >= 10_000) clearInterval(timer); }, 50);
  }
  return () => {
    active = false;
    clearInterval(timer);
    unsubscribe?.();
    window.removeEventListener("storage", refresh);
    window.removeEventListener("focus", refresh);
    window.removeEventListener("languagechange", refresh);
  };
};
