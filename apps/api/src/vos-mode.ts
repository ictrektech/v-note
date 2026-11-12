import type { Bindings } from "./api-context";

const VOS_DISABLED_API_PATHS = [
  /^\/api\/public(?:\/|$)/,
  /^\/api\/v1\/memo-shares(?:\/|$)/,
  /^\/api\/v1\/memos\/[^/]+\/(?:share|notebook-sites|form)(?:\/|$)/,
  /^\/api\/v1\/notebook-shares(?:\/|$)/,
  /^\/api\/v1\/notebooks\/[^/]+\/share(?:\/|$)/,
] as const;

export const isVosMode = (env: Pick<Bindings, "EDGE_EVER_VOS_MODE">) =>
  env.EDGE_EVER_VOS_MODE?.trim().toLowerCase() === "true";

/** Anonymous sharing, notebook publishing, and public forms are disabled in VOS builds. */
export const isVosDisabledApiPath = (pathname: string) =>
  VOS_DISABLED_API_PATHS.some((pattern) => pattern.test(pathname));

export const isVosDisabledPagePath = (pathname: string) =>
  pathname.startsWith("/share/")
  || pathname.startsWith("/s/")
  || pathname.startsWith("/form/");
