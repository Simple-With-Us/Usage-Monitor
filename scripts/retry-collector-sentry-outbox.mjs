#!/usr/bin/env node
import { retryCollectorSentryQuarantine } from "./lib/collector-sentry-bridge.mjs";

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--outbox-dir") || !args.includes("--event-id")) throw new Error("Provide --outbox-dir and one exact --event-id");
console.log(JSON.stringify(await retryCollectorSentryQuarantine(value("--outbox-dir"), value("--event-id"))));
