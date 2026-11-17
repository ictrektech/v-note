import { afterEach, expect, test } from "bun:test";
import { checkHybragPlatformGrant, issueHybragPlatformGrant, revokeHybragPlatformGrant } from "./hybrag-platform-grant.ts";

let server;
afterEach(() => { server?.stop(true); server = undefined; });

test("grant calls use the platform origin and never forward the user proof to status", async () => {
  const requests = [];
  const secret = "a".repeat(64);
  server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push({ path, authorization: request.headers.get("authorization"), body: await request.json() });
    return Response.json(path.endsWith("/issue") ? { protocol: 1, secret, subject: "owner" } : { protocol: 1, active: path.endsWith("/status"), subject: "owner" });
  } });
  const env = { EDGE_EVER_VOS_USERINFO_URL: `http://127.0.0.1:${server.port}/v1000/oauth2/userinfo` };
  expect(await issueHybragPlatformGrant(env, "human-proof", "owner")).toBe(secret);
  expect(await checkHybragPlatformGrant(env, secret, "owner")).toBe(true);
  expect(await checkHybragPlatformGrant(env, secret, "other")).toBe(false);
  await revokeHybragPlatformGrant(env, secret);
  expect(requests).toEqual([
    { path: "/v1000/oauth2/integration-grant/issue", authorization: "Bearer human-proof", body: { consent: true } },
    { path: "/v1000/oauth2/integration-grant/status", authorization: null, body: { secret } },
    { path: "/v1000/oauth2/integration-grant/status", authorization: null, body: { secret } },
    { path: "/v1000/oauth2/integration-grant/revoke", authorization: null, body: { secret } },
  ]);
});

test("a grant issued for another subject is rejected and revoked", async () => {
  const paths = [];
  server = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    paths.push(path);
    return Response.json(path.endsWith("/issue")
      ? { protocol: 1, secret: "b".repeat(64), subject: "other" }
      : { protocol: 1, active: false });
  } });
  const env = { EDGE_EVER_VOS_USERINFO_URL: `http://127.0.0.1:${server.port}/v1000/oauth2/userinfo` };
  await expect(issueHybragPlatformGrant(env, "human-proof", "owner")).rejects.toThrow();
  expect(paths).toEqual(["/v1000/oauth2/integration-grant/issue", "/v1000/oauth2/integration-grant/revoke"]);
});

test("unavailable, redirected, malformed and unknown protocol responses fail closed", async () => {
  let mode = "malformed";
  server = Bun.serve({ port: 0, fetch() {
    if (mode === "redirect") return Response.redirect("http://127.0.0.1:1");
    if (mode === "missing-subject") return Response.json({ protocol: 1, active: true });
    return Response.json(mode === "unknown" ? { protocol: 2, active: true } : { protocol: 1, active: "true" });
  } });
  const env = { EDGE_EVER_VOS_USERINFO_URL: `http://127.0.0.1:${server.port}/v1000/oauth2/userinfo` };
  for (mode of ["malformed", "unknown", "redirect"]) await expect(checkHybragPlatformGrant(env, "a".repeat(64))).rejects.toThrow();
  mode = "missing-subject";
  // Legacy responses cannot establish which owner the credential belongs to.
  expect(await checkHybragPlatformGrant(env, "a".repeat(64), "owner")).toBe(false);
  expect(await checkHybragPlatformGrant(env, "bad")).toBe(false);
  await expect(checkHybragPlatformGrant({ EDGE_EVER_VOS_USERINFO_URL: "http://127.0.0.1:1/v1000/oauth2/userinfo" }, "a".repeat(64))).rejects.toThrow();
});
