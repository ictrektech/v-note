import { describe, expect, test } from "bun:test";
import { resolveResourceUrlForBase } from "./vos-mode.ts";

describe("VOS resource URLs", () => {
  test("routes stored root-relative resources under the application", () => {
    const base = "/app/com.ictrek.v-note/";
    const path = "/api/v1/resources/example/blob?download=1";
    expect(resolveResourceUrlForBase(path, base)).toBe(`/app/com.ictrek.v-note${path}`);
    expect(resolveResourceUrlForBase(`/app/com.ictrek.v-note${path}`, base)).toBe(`/app/com.ictrek.v-note${path}`);
    expect(resolveResourceUrlForBase("https://example.com/file", base)).toBe("https://example.com/file");
    expect(resolveResourceUrlForBase(path, "/")).toBe(path);
  });
});
