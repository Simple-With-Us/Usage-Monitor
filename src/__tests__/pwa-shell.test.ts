import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

describe("PWA install shell", () => {
  it("publishes standalone metadata and full-size icons", () => {
    const value = manifest();

    expect(value).toMatchObject({
      id: "/",
      start_url: "/",
      scope: "/",
      display: "standalone",
    });
    expect(value.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/pwa-icon/192", sizes: "192x192" }),
        expect.objectContaining({ src: "/pwa-icon/512", sizes: "512x512" }),
      ])
    );
  });

  it("never intercepts or caches authenticated application traffic", () => {
    const source = readFileSync(path.join(process.cwd(), "public", "sw.js"), "utf8");

    expect(source).not.toMatch(/addEventListener\(["']fetch["']/);
    expect(source).not.toContain("caches.open");
    expect(source).not.toContain("cache.put");
    expect(source).toContain("Intentionally no fetch handler");
  });
});
