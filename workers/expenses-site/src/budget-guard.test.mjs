import assert from "node:assert/strict";
import { test } from "node:test";
import { BudgetExceeded, createBudget, guardOff, guardOffResponse, recordD1 } from "./budget-guard.mjs";

const quiet = { log: () => {} };

test("refuses once the invocation cap is reached", () => {
  const budget = createBudget({ worker: "t", perInvocation: { kvWrite: 2 }, ...quiet });
  const run = budget.invocation();
  run.spend("kvWrite");
  run.spend("kvWrite");
  assert.throws(() => run.spend("kvWrite"), BudgetExceeded);
  assert.doesNotThrow(() => budget.invocation().spend("kvWrite"));
});

test("the minute cap spans invocations and resets on the next minute", () => {
  let clock = 0;
  const budget = createBudget({ worker: "t", perMinute: { fetch: 2 }, now: () => clock, ...quiet });
  budget.invocation().spend("fetch");
  budget.invocation().spend("fetch");
  assert.throws(() => budget.invocation().spend("fetch"), BudgetExceeded);
  clock = 60_000;
  assert.doesNotThrow(() => budget.invocation().spend("fetch"));
});

test("D1 row counts come from statement meta and stop the next statement", () => {
  const budget = createBudget({ worker: "t", perInvocation: { d1RowsWritten: 100 }, ...quiet });
  const run = budget.invocation();
  recordD1(run, [{ meta: { rows_written: 60 } }, { meta: { rows_written: 50, rows_read: 3 } }]);
  assert.throws(() => run.check("d1RowsWritten"), BudgetExceeded);
  assert.equal(run.used().d1RowsRead, 3);
});

test("a kind with no cap is only counted", () => {
  const run = createBudget({ worker: "t", ...quiet }).invocation();
  run.spend("r2Put", 5);
  assert.equal(run.used().r2Put, 5);
});

test("logs at most once per minute during a trip", () => {
  const lines = [];
  const budget = createBudget({ worker: "t", perInvocation: { x: 0 }, now: () => 0, log: (l) => lines.push(l) });
  const run = budget.invocation();
  assert.throws(() => run.spend("x"));
  assert.throws(() => run.spend("x"));
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).event, "budget_exceeded");
});

test("GUARD_MODE off answers 503 with retry-after", () => {
  assert.equal(guardOff({ GUARD_MODE: "off" }), true);
  assert.equal(guardOff({ GUARD_MODE: "on" }), false);
  assert.equal(guardOff({}), false);
  const response = guardOffResponse();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "3600");
});
