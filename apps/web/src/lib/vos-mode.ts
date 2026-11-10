export const isVosBuild = import.meta.env.VITE_VOS === "true";

export const VOS_APP_ID = "com.ictrek.v-note";

export const isVosLocalLogin = () => {
  if (typeof window === "undefined") return false;
  return new URLSearchParams(window.location.search).get("local") === "1";
};

/** Absolute app mount URL without a trailing slash. */
export const getAppBaseUrl = () => {
  if (typeof window === "undefined") return "";
  return new URL(import.meta.env.BASE_URL || "/", window.location.origin).href.replace(/\/+$/, "");
};

export const getWebApiBaseUrl = () => (isVosBuild ? getAppBaseUrl() : "");

export const resolveResourceUrlForBase = (url: string, base: string) =>
  url.startsWith("/api/v1/resources/") ? `${base.replace(/\/$/, "")}${url}` : url;

export const resolveVosResourceUrl = (url: string) =>
  isVosBuild ? resolveResourceUrlForBase(url, import.meta.env.BASE_URL || "/") : url;
