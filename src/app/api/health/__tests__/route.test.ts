import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "../route";

// Unauthenticated liveness endpoint — no session/token wiring needed. This
// covers the checks.storage.r2Weekly block added to match the fleet-standard
// shape Socratic.Trade and Congress.Trade already expose (see
// runtime-health.test.ts for the underlying getPublicR2WeeklyHealth cases).
describe("GET /api/health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is ok and live with no auth", async () => {
    vi.stubEnv("R2_ARCHIVE_STATUS_PATH", join(tmpdir(), "definitely-absent.json"));
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(body.status).toBe("live");
  });

  it("exposes checks.storage.r2Weekly with no_receipt when the archive job has never run", async () => {
    vi.stubEnv("R2_ARCHIVE_STATUS_PATH", join(tmpdir(), "definitely-absent.json"));
    const response = await GET();
    const body = await response.json();
    expect(body.checks.storage.r2Weekly).toEqual({
      ok: false,
      key: null,
      ageSeconds: null,
      staleness: "unknown",
      reason: "no_receipt",
    });
  });

  it("exposes a fresh r2Weekly archive as ok/fresh", async () => {
    const dir = mkdtempSync(join(tmpdir(), "r2-archive-status-"));
    const path = join(dir, "status.json");
    writeFileSync(
      path,
      JSON.stringify({
        ok: true,
        key: "weekly/prod-2026-08-12T00-00-00Z.db.gz",
        completedAt: new Date(Date.now() - 3_600_000).toISOString(),
      }),
      "utf8"
    );
    vi.stubEnv("R2_ARCHIVE_STATUS_PATH", path);

    const response = await GET();
    const body = await response.json();
    expect(body.checks.storage.r2Weekly.ok).toBe(true);
    expect(body.checks.storage.r2Weekly.staleness).toBe("fresh");
    expect(body.checks.storage.r2Weekly.key).toBe(
      "weekly/prod-2026-08-12T00-00-00Z.db.gz"
    );
  });
});
