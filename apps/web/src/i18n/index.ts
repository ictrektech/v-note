import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import {
  clearStoredLocale,
  defaultLocale,
  getBrowserLocale,
  getInitialLocale,
  readStoredLocale,
  supportedLocales,
  writeStoredLocale,
  type AppLocalePreference,
  type SupportedLocale,
} from "./locales";
import { zhCN } from "./resources/zh-CN";
import { isVosBuild } from "@/lib/vos-mode";
import { listenForVosLocale, readVosLocale } from "./vos-locale";

export {
  defaultLocale,
  getAppLocalePreference,
  localeLabels,
  supportedLocales,
  type AppLocalePreference,
  type SupportedLocale,
} from "./locales";

export const resources = {
  "zh-CN": { translation: zhCN },
} as const;

type OptionalLocale = Exclude<SupportedLocale, keyof typeof resources>;

const isOptionalLocale = (locale: SupportedLocale): locale is OptionalLocale =>
  locale !== "zh-CN";

const loadOptionalCatalog = async (locale: OptionalLocale) => {
  if (locale === "zh-TW") {
    return (await import("./resources/zh-TW")).zhTW;
  }
  if (locale === "en-US") {
    return (await import("./resources/en-US")).enUS;
  }
  if (locale === "ja") {
    return (await import("./resources/ja")).ja;
  }
  if (locale === "pl") {
    return (await import("./resources/pl")).pl;
  }
  if (locale === "ru") {
    return (await import("./resources/ru")).ru;
  }
  if (locale === "es") {
    return (await import("./resources/es")).es;
  }
  if (locale === "de") {
    return (await import("./resources/de")).de;
  }
  return (await import("./resources/fr")).fr;
};

const ensureLocaleCatalog = async (locale: SupportedLocale) => {
  if (!isOptionalLocale(locale) || i18n.hasResourceBundle(locale, "translation")) {
    return;
  }

  if (locale !== "en-US") {
    await ensureLocaleCatalog("en-US");
  }
  i18n.addResourceBundle(locale, "translation", await loadOptionalCatalog(locale), true, true);
};

void i18n.use(initReactI18next).init({
  resources,
  lng: isOptionalLocale(getInitialLocale()) ? defaultLocale : getInitialLocale(),
  fallbackLng: {
    "zh-TW": ["zh-CN"],
    ja: ["en-US"],
    pl: ["en-US"],
    ru: ["en-US"],
    es: ["en-US"],
    de: ["en-US"],
    default: [defaultLocale],
  },
  supportedLngs: supportedLocales,
  partialBundledLanguages: true,
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
});

i18n.on("languageChanged", (locale) => {
  const supported = supportedLocales.find((item) => item === locale);

  if (supported) {
    document.documentElement.lang = supported;
  }
});

document.documentElement.lang = i18n.resolvedLanguage ?? i18n.language ?? defaultLocale;

let vosLocale: SupportedLocale | null = null;
let languageRevision = 0;
const applyLocale = async (locale: SupportedLocale) => {
  const revision = ++languageRevision;
  await ensureLocaleCatalog(locale);
  if (revision === languageRevision) await i18n.changeLanguage(locale);
};

const systemLocale = () => (isVosBuild ? vosLocale ?? readVosLocale() : null) ?? getBrowserLocale() ?? defaultLocale;

export const bootstrapI18n = async () => {
  await applyLocale(isVosBuild ? readStoredLocale() ?? systemLocale() : getInitialLocale());
  if (isVosBuild) {
    listenForVosLocale((locale) => {
      vosLocale = locale;
      if (!readStoredLocale()) void applyLocale(systemLocale()).catch(() => undefined);
    });
  }
};

export const changeAppLocale = async (locale: SupportedLocale) => {
  writeStoredLocale(locale);
  return applyLocale(locale);
};

export const changeAppLocalePreference = async (preference: AppLocalePreference) => {
  if (preference === "system") {
    clearStoredLocale();
    return applyLocale(systemLocale());
  }

  return changeAppLocale(preference);
};

export default i18n;
