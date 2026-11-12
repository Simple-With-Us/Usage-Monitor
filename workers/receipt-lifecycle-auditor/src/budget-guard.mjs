// In-memory runaway guard for Cloudflare Workers and Durable Objects.  It never
// touches KV, D1, R2 or DO storage to track itself, so checking it costs nothing.
//
// It bounds one invocation and one isolate per fixed clock minute.  The minute is a
// counter that resets, not a rolling window, so a burst straddling a boundary can
// reach twice the cap in moments; the sustained rate still holds.  Isolates share no
// memory, so an account-wide day is bounded by the watchdog and the plan, not here.
//
// A BudgetExceeded error must be treated as non-retryable: a DO alarm has to catch
// it, because an alarm that throws is retried and each retry is billed.

export class BudgetExceeded extends Error {
  constructor(kind, scope, cap) {
    super(`budget exceeded: ${kind} over ${cap} per ${scope}`);
    this.name = "BudgetExceeded";
    this.kind = kind;
    this.scope = scope;
    this.cap = cap;
  }
}

const MINUTE_MS = 60_000;

export function createBudget(options) {
  const {
    worker,
    perInvocation = {},
    perMinute = {},
    now = Date.now,
    log = (line) => console.warn(line),
  } = options;
  let minute = Math.floor(now() / MINUTE_MS);
  let isolate = Object.create(null);
  let loggedMinute = -1;

  function rollMinute() {
    const current = Math.floor(now() / MINUTE_MS);
    if (current !== minute) {
      minute = current;
      isolate = Object.create(null);
    }
  }

  function trip(kind, scope, cap) {
    if (loggedMinute !== minute) {
      loggedMinute = minute;
      log(JSON.stringify({ event: "budget_exceeded", worker, kind, scope, cap }));
    }
    throw new BudgetExceeded(kind, scope, cap);
  }

  return {
    // One per request, alarm, cron or email event, passed to everything that event
    // does.  A new scope per operation counts nothing, so perInvocation never trips.
    invocation() {
      const used = Object.create(null);
      const check = (kind) => {
        rollMinute();
        const invocationCap = perInvocation[kind];
        if (invocationCap !== undefined && (used[kind] ?? 0) >= invocationCap) {
          trip(kind, "invocation", invocationCap);
        }
        const minuteCap = perMinute[kind];
        if (minuteCap !== undefined && (isolate[kind] ?? 0) >= minuteCap) {
          trip(kind, "minute", minuteCap);
        }
      };
      const record = (kind, amount) => {
        used[kind] = (used[kind] ?? 0) + amount;
        isolate[kind] = (isolate[kind] ?? 0) + amount;
      };
      return {
        // Call before a billable operation.  Refuses once the cap is reached.
        spend(kind, amount = 1) {
          check(kind);
          record(kind, amount);
        },
        check,
        record,
        used: () => ({ ...used }),
      };
    },
  };
}

// Use after a D1 statement or batch: real row counts come from meta, so they are
// recorded after the call and the next call is refused.
export function recordD1(invocation, results) {
  for (const result of Array.isArray(results) ? results : [results]) {
    const meta = result?.meta ?? {};
    invocation.record("d1RowsWritten", meta.rows_written ?? 0);
    invocation.record("d1RowsRead", meta.rows_read ?? 0);
  }
}

// GUARD_MODE=off is what the account watchdog sets to stop a Worker.  Check it first
// in fetch, scheduled, email and alarm handlers, before any billable work.
export function guardOff(env) {
  return env?.GUARD_MODE === "off";
}

export function guardOffResponse() {
  return new Response("service paused by usage guard", {
    status: 503,
    headers: { "retry-after": "3600", "content-type": "text/plain" },
  });
}
