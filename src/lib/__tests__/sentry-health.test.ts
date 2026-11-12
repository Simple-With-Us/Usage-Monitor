import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fetchSentryHealth, isSentryHealthConfigured } from "../sentry-health";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  delete process.env.SENTRY_READ_TOKEN;
  delete process.env.SENTRY_ORG;
  delete process.env.SENTRY_SELF_PROJECT;
}

describe("sentry-health", () => {
  beforeEach(() => {
    resetEnv();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetEnv();
  });

  it("reports unconfigured when SENTRY_READ_TOKEN is not set", async () => {
    expect(isSentryHealthConfigured()).toBe(false);
    const result = await fetchSentryHealth();
    expect(result).toEqual({ configured: false });
  });

  it("fetches per-project unresolved counts when configured", async () => {
    process.env.SENTRY_READ_TOKEN = "test-sentry-token";
    process.env.SENTRY_ORG = "jays-services";
    expect(isSentryHealthConfigured()).toBe(true);

    const fetchMock = vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      const urlStr = String(url);
      const projectSlug = urlStr.includes("usage-monitor")
        ? "usage-monitor"
        : urlStr.includes("socratic-trade")
          ? "socratic-trade"
          : urlStr.includes("congress-trade")
            ? "congress-trade"
            : urlStr.includes("dealdex")
              ? "dealdex"
              : urlStr.includes("botfleet")
                ? "botfleet"
                : urlStr.includes("autorotate")
                  ? "autorotate"
                  : urlStr.includes("contactlogo")
                    ? "contactlogo"
                    : "fleet-infra";
      const bodies: Record<string, unknown[]> = {
        "usage-monitor": [{ id: "9" }],
        "socratic-trade": [{ id: "1" }, { id: "2" }],
        "congress-trade": [],
        "fleet-infra": [{ id: "3" }],
        "dealdex": [],
        "botfleet": [],
        "autorotate": [],
        "contactlogo": [],
      };
      return new Response(JSON.stringify(bodies[projectSlug] || []), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const result = await fetchSentryHealth();
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("expected configured result");
    expect(result.org).toBe("jays-services");
    expect(result.projects).toHaveLength(8);

    const bySlug = new Map(result.projects.map((p) => [p.projectSlug, p]));
    expect(bySlug.get("usage-monitor")!.unresolvedCount).toBe(1);
    expect(bySlug.get("usage-monitor")!.displayName).toBe("Usage Monitor (this app)");
    expect(bySlug.get("socratic-trade")!.unresolvedCount).toBe(2);
    expect(bySlug.get("congress-trade")!.unresolvedCount).toBe(0);
    expect(bySlug.get("fleet-infra")!.unresolvedCount).toBe(1);
    expect(bySlug.get("dealdex")!.unresolvedCount).toBe(0);
    expect(bySlug.get("botfleet")!.unresolvedCount).toBe(0);
    expect(bySlug.get("autorotate")!.unresolvedCount).toBe(0);
    expect(bySlug.get("contactlogo")!.unresolvedCount).toBe(0);
    for (const project of result.projects) {
      expect(project.issuesUrl).toContain("sentry.io");
      expect(project.error).toBeUndefined();
    }

    fetchMock.mockRestore();
  });

  it("uses SENTRY_SELF_PROJECT for the self-project slug when set", async () => {
    process.env.SENTRY_READ_TOKEN = "test-sentry-token";
    process.env.SENTRY_SELF_PROJECT = "usage-monitor-prod";

    const requestedUrls: string[] = [];
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      requestedUrls.push(String(url));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await fetchSentryHealth();
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("expected configured result");
    expect(result.projects).toHaveLength(8);
    const selfProject = result.projects[0];
    expect(selfProject.projectSlug).toBe("usage-monitor-prod");
    expect(selfProject.displayName).toBe("Usage Monitor (this app)");
    expect(requestedUrls.some((u) => u.includes("/usage-monitor-prod/"))).toBe(true);
    expect(requestedUrls.some((u) => u.includes("/usage-monitor/"))).toBe(false);
  });

  it("dedupes the self project when SENTRY_SELF_PROJECT matches a fleet slug", async () => {
    process.env.SENTRY_READ_TOKEN = "test-sentry-token";
    process.env.SENTRY_SELF_PROJECT = "fleet-infra";
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    );

    const result = await fetchSentryHealth();
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("expected configured result");
    expect(result.projects).toHaveLength(7);
    expect(
      result.projects.filter((p) => p.projectSlug === "fleet-infra")
    ).toHaveLength(1);
  });

  it("defaults SENTRY_ORG to simple-with-us when unset", async () => {
    process.env.SENTRY_READ_TOKEN = "test-sentry-token";
    vi.spyOn(global, "fetch").mockResolvedValue(
      new Response("[]", { status: 200, headers: { "content-type": "application/json" } })
    );

    const result = await fetchSentryHealth();
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("expected configured result");
    expect(result.org).toBe("simple-with-us");
  });

  it("captures a per-project error without failing the whole request", async () => {
    process.env.SENTRY_READ_TOKEN = "test-sentry-token";
    vi.spyOn(global, "fetch").mockImplementation(async (url) => {
      if (String(url).includes("congress-trade")) {
        return new Response("Forbidden", { status: 403 });
      }
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });

    const result = await fetchSentryHealth();
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("expected configured result");
    const congressProject = result.projects.find((p) => p.projectSlug === "congress-trade")!;
    expect(congressProject.error).toBe("HTTP 403");
    expect(congressProject.unresolvedCount).toBe(0);
    // Other projects are unaffected.
    const otherProjects = result.projects.filter((p) => p.projectSlug !== "congress-trade");
    for (const project of otherProjects) {
      expect(project.error).toBeUndefined();
    }
  });

  it("captures a network failure as a per-project error, never throws", async () => {
    process.env.SENTRY_READ_TOKEN = "test-sentry-token";
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    const result = await expect(fetchSentryHealth()).resolves.toBeDefined();
    void result;
    const summary = await fetchSentryHealth();
    expect(summary.configured).toBe(true);
    if (!summary.configured) throw new Error("expected configured result");
    for (const project of summary.projects) {
      expect(project.error).toBe("network down");
    }
  });
});
