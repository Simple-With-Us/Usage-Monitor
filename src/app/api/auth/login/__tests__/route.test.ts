import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const PASSWORD = "the-correct-password";

async function freshRoute(): Promise<typeof import("../route")> {
  // Rate limiters are module-level singletons created at import time; reset
  // the module registry so each test that depends on limiter counts starts
  // from a clean state instead of sharing counters with earlier tests.
  vi.resetModules();
  return import("../route");
}

function loginRequest(
  password: unknown,
  forwardedFor: string,
  overrides: Record<string, string> = {}
): NextRequest {
  return new NextRequest("https://usage.jays.services/api/auth/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": forwardedFor,
      ...overrides,
    },
    body: JSON.stringify({ password }),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    process.env.DASHBOARD_PASSWORD = PASSWORD;
    process.env.SESSION_SECRET = "test-session-secret";
  });

  afterEach(() => {
    delete process.env.DASHBOARD_PASSWORD;
    delete process.env.SESSION_SECRET;
    vi.resetModules();
  });

  it("returns 503 when DASHBOARD_PASSWORD is not configured", async () => {
    delete process.env.DASHBOARD_PASSWORD;
    const { POST } = await freshRoute();
    const res = await POST(loginRequest(PASSWORD, "1.1.1.1"));
    expect(res.status).toBe(503);
  });

  it("returns 503 when SESSION_SECRET is not configured", async () => {
    delete process.env.SESSION_SECRET;
    const { POST } = await freshRoute();
    const res = await POST(loginRequest(PASSWORD, "1.1.1.1"));
    expect(res.status).toBe(503);
  });

  it("logs in successfully with the correct password and sets the session cookie", async () => {
    const { POST } = await freshRoute();
    const res = await POST(loginRequest(PASSWORD, "1.1.1.1"));
    expect(res.status).toBe(200);
    expect(res.cookies.get("dashboard_session")).toBeTruthy();
  });

  it("rejects an incorrect password with 401", async () => {
    const { POST } = await freshRoute();
    const res = await POST(loginRequest("wrong-password", "1.1.1.1"));
    expect(res.status).toBe(401);
  });

  it("blocks after 5 attempts from the same trusted (rightmost hop, cf-connecting-ip) tuple", async () => {
    const { POST } = await freshRoute();
    for (let i = 0; i < 5; i++) {
      const res = await POST(loginRequest("wrong", "9.9.9.9"));
      expect(res.status).toBe(401);
    }
    const sixth = await POST(loginRequest("wrong", "9.9.9.9"));
    expect(sixth.status).toBe(429);

    // Even the correct password is now rate-limited from this tuple.
    const correctButLimited = await POST(loginRequest(PASSWORD, "9.9.9.9"));
    expect(correctButLimited.status).toBe(429);
  });

  it("is not bypassed by rotating the client-controlled (leftmost) XFF prefix", async () => {
    // Every request claims a different attacker-supplied leftmost hop, but
    // the rightmost hop - the one the deployment's proxy actually appended -
    // stays fixed. Per-client limiting must key off that trusted hop (paired
    // with cf-connecting-ip) only.
    const { POST } = await freshRoute();
    for (let i = 0; i < 5; i++) {
      const res = await POST(loginRequest("wrong", `10.0.0.${i}, 9.9.9.9`));
      expect(res.status).toBe(401);
    }
    const sixth = await POST(loginRequest("wrong", "10.0.0.99, 9.9.9.9"));
    expect(sixth.status).toBe(429);
  });

  it("isolates two CF clients sharing an egress IP: one exhausting its budget doesn't block the other", async () => {
    // Documents the CF -> Render topology: usage.jays.services is always
    // fronted by Cloudflare, so two distinct end clients proxied through it
    // present the SAME rightmost XFF hop (Cloudflare's shared egress IP -
    // 173.245.48.1 is within Cloudflare's published 173.245.48.0/20 range,
    // so it exercises the same CF-trust path production traffic does).
    // CF-Connecting-IP - set by Cloudflare itself, not the client - is what
    // separates them into independent buckets.
    const { POST } = await freshRoute();
    const CF_EGRESS_IP = "173.245.48.1"; // shared rightmost XFF hop for both clients
    const clientA = (password: unknown) =>
      loginRequest(password, CF_EGRESS_IP, { "cf-connecting-ip": "198.51.100.11" });
    const clientB = (password: unknown) =>
      loginRequest(password, CF_EGRESS_IP, { "cf-connecting-ip": "198.51.100.22" });

    // Client A exhausts its own 5/min tuple budget.
    for (let i = 0; i < 5; i++) {
      expect((await POST(clientA("wrong"))).status).toBe(401);
    }
    expect((await POST(clientA("wrong"))).status).toBe(429);

    // Client B, sharing the same egress IP but a distinct CF-Connecting-IP,
    // is unaffected and can still log in successfully.
    const res = await POST(clientB(PASSWORD));
    expect(res.status).toBe(200);
  });

  it("does not let distinct CF-proxied attackers sharing an egress IP drain a shared backstop and lock out the owner", async () => {
    // Regression test for the exact production (Cloudflare -> Render) attack
    // this backstop must resist: several distinct CF-proxied attacker
    // clients, each staying within its OWN 5/min tuple budget, all egress
    // through the same shared Cloudflare IP. Before keying the backstop by
    // CF-Connecting-IP for genuine Cloudflare traffic, their combined failed
    // attempts drained one shared per-rightmost-hop bucket and 429'd the
    // legitimate owner - who shares that same egress IP - even with the
    // correct password.
    const { POST } = await freshRoute();
    const CF_EGRESS_IP = "173.245.48.1"; // within Cloudflare's published range
    const attackerCfIps = ["198.51.100.1", "198.51.100.2", "198.51.100.3", "198.51.100.4"];

    // Four distinct attacker clients each send 5 failed attempts (exactly
    // their own tuple budget, so the tuple limiter alone never blocks them)
    // - 20 failed attempts total through the shared egress IP, which would
    // have exhausted the old rightmost-hop-only backstop's ~20/min budget.
    for (const cfIp of attackerCfIps) {
      for (let i = 0; i < 5; i++) {
        const res = await POST(
          loginRequest("wrong", CF_EGRESS_IP, { "cf-connecting-ip": cfIp })
        );
        expect(res.status).toBe(401);
      }
    }

    // The owner, a fifth distinct CF client sharing the same egress IP, logs
    // in with the correct password and must succeed - not 429.
    const ownerRes = await POST(
      loginRequest(PASSWORD, CF_EGRESS_IP, { "cf-connecting-ip": "198.51.100.99" })
    );
    expect(ownerRes.status).toBe(200);
  });

  it("still exhausts a direct peer's backstop even when it forges/rotates cf-connecting-ip", async () => {
    // Traffic that reaches Render directly (bypassing Cloudflare): the
    // rightmost XFF hop is that peer's own unspoofable address, and it is
    // NOT one of Cloudflare's published ranges, so the backstop falls back
    // to keying on it alone. Forging a different cf-connecting-ip on every
    // request fragments the tuple limiter into many distinct buckets, but
    // the backstop re-aggregates by the one hop the attacker cannot change
    // and still trips.
    const { POST } = await freshRoute();
    const DIRECT_PEER_IP = "45.33.12.9"; // not a Cloudflare IP
    let sawRateLimited = false;
    for (let i = 0; i < 25; i++) {
      const res = await POST(
        loginRequest("wrong", DIRECT_PEER_IP, { "cf-connecting-ip": `10.10.10.${i}` })
      );
      if (res.status === 429) {
        sawRateLimited = true;
        break;
      }
      expect(res.status).toBe(401);
    }
    expect(sawRateLimited).toBe(true);
  });

  it("does not let one rightmost hop's backstop exhaustion block a different hop", async () => {
    const { POST } = await freshRoute();
    const ATTACKER_PEER_IP = "45.33.12.9"; // not a Cloudflare IP
    // Drain the attacker's backstop by rotating cf-connecting-ip 20 times.
    for (let i = 0; i < 20; i++) {
      const res = await POST(
        loginRequest("wrong", ATTACKER_PEER_IP, { "cf-connecting-ip": `10.10.10.${i}` })
      );
      expect(res.status).toBe(401);
    }
    const blocked = await POST(
      loginRequest("wrong", ATTACKER_PEER_IP, { "cf-connecting-ip": "10.10.10.99" })
    );
    expect(blocked.status).toBe(429);

    // A different rightmost hop (e.g. the real owner, or Cloudflare's shared
    // egress serving unrelated traffic) is entirely unaffected.
    const unrelated = await POST(loginRequest(PASSWORD, "8.8.8.8"));
    expect(unrelated.status).toBe(200);
  });

  it("does not consume rate-limit budget on a successful login", async () => {
    const { POST } = await freshRoute();
    const SAME_TUPLE_IP = "77.77.77.77";

    // Log in successfully 10 times in a row from the same tuple - well past
    // the 5/min per-tuple budget, which would 429 if successes consumed.
    for (let i = 0; i < 10; i++) {
      const res = await POST(loginRequest(PASSWORD, SAME_TUPLE_IP));
      expect(res.status).toBe(200);
    }

    // The budget is still fully available afterwards: 5 failed attempts are
    // still allowed before the limiter trips.
    for (let i = 0; i < 5; i++) {
      const res = await POST(loginRequest("wrong", SAME_TUPLE_IP));
      expect(res.status).toBe(401);
    }
    const sixth = await POST(loginRequest("wrong", SAME_TUPLE_IP));
    expect(sixth.status).toBe(429);
  });

  it("consumes rate-limit budget on a failed login", async () => {
    const { POST } = await freshRoute();
    const SAME_TUPLE_IP = "88.88.88.88";

    for (let i = 0; i < 5; i++) {
      const res = await POST(loginRequest("wrong", SAME_TUPLE_IP));
      expect(res.status).toBe(401);
    }
    // Budget is now exhausted - even the correct password is blocked before
    // verification runs, proving failed attempts did consume the budget.
    const res = await POST(loginRequest(PASSWORD, SAME_TUPLE_IP));
    expect(res.status).toBe(429);
  });

  it("rejects an oversized body with the uniform 401 and consumes rate-limit budget", async () => {
    const { POST } = await freshRoute();
    const SAME_TUPLE_IP = "99.99.99.99";

    // {"password":"xxx..."} well past the route's 4 KiB ceiling. The bounded
    // reader must reject it with the same uniform 401 as a wrong password (no
    // response oracle) - never a distinct 413 - and each rejection must burn
    // rate-limit budget so a body flood is not free.
    const oversized = "x".repeat(8192);
    for (let i = 0; i < 5; i++) {
      const res = await POST(loginRequest(oversized, SAME_TUPLE_IP));
      expect(res.status).toBe(401);
    }
    const blocked = await POST(loginRequest(PASSWORD, SAME_TUPLE_IP));
    expect(blocked.status).toBe(429);
  });

  it("rejects malformed JSON with the uniform 401 and consumes rate-limit budget", async () => {
    const { POST } = await freshRoute();
    const SAME_TUPLE_IP = "111.111.111.111";

    for (let i = 0; i < 5; i++) {
      const res = await POST(
        new NextRequest("https://usage.jays.services/api/auth/login", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": SAME_TUPLE_IP,
          },
          body: '{"password": not-json',
        })
      );
      expect(res.status).toBe(401);
    }
    const blocked = await POST(loginRequest(PASSWORD, SAME_TUPLE_IP));
    expect(blocked.status).toBe(429);
  });

  it("still accepts a correct login in a small body after an oversized attempt from a different tuple", async () => {
    // The oversized rejection must be scoped to the offending tuple's budget,
    // not break the parser or leak state across clients.
    const { POST } = await freshRoute();
    const oversizedRes = await POST(loginRequest("x".repeat(8192), "3.3.3.3"));
    expect(oversizedRes.status).toBe(401);

    const ok = await POST(loginRequest(PASSWORD, "4.4.4.4"));
    expect(ok.status).toBe(200);
  });
});
