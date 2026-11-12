#!/usr/bin/env node
/**
 * POST owner-recorded expenses from a local JSON file.
 * Amounts stay out of git.  Pass a 0600 JSON path.
 *
 *   node scripts/file-owner-receipt-expenses.mjs /path/to/bills.json \
 *     --base https://usage.jays.services
 *
 * Auth: dashboard session via DASHBOARD_PASSWORD, or OWNER_EXPENSE_TOKEN.
 */
import fs from "node:fs";
import process from "node:process";

function argValue(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index === process.argv.length - 1) return fallback;
  return process.argv[index + 1];
}

const jsonPath = process.argv[2];
if (!jsonPath || jsonPath.startsWith("-")) {
  console.error("usage: file-owner-receipt-expenses.mjs <bills.json> [--base URL]");
  process.exit(2);
}

const base = (argValue("--base", "https://usage.jays.services")).replace(/\/$/, "");
const payload = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
const expenses = Array.isArray(payload.expenses) ? payload.expenses : [];

async function sessionCookie() {
  const password = process.env.DASHBOARD_PASSWORD?.trim();
  if (!password) return null;
  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    redirect: "manual",
  });
  const setCookie = response.headers.get("set-cookie") || "";
  const cookieName = "dashboard_session";
  const named = new RegExp(`${cookieName}=([^;]+)`).exec(setCookie);
  return named ? `${cookieName}=${named[1]}` : null;
}

const cookie = await sessionCookie();
const token = process.env.OWNER_EXPENSE_TOKEN?.trim() || "";
if (!cookie && token.length < 32) {
  console.error("Need DASHBOARD_PASSWORD (session) or OWNER_EXPENSE_TOKEN.");
  process.exit(1);
}

let persisted = 0;
let skipped = 0;
let failed = 0;
for (const expense of expenses) {
  const headers = { "Content-Type": "application/json" };
  if (cookie) headers.Cookie = cookie;
  if (token.length >= 32) {
    headers.Authorization = `Bearer ${token}`;
    headers["x-owner-expense-token"] = token;
  }
  const response = await fetch(`${base}/api/owner-expenses`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      confidence: expense.confidence || "actual",
      ...expense,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    failed += 1;
    console.error("FAIL", expense.label, response.status, body.error || "");
    continue;
  }
  if (body.persisted > 0) persisted += 1;
  else skipped += 1;
}

console.log(JSON.stringify({ total: expenses.length, persisted, skipped, failed }));
if (failed > 0) process.exit(1);
