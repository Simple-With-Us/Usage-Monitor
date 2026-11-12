#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pruneCollectorSentryReceipts } from "./lib/collector-sentry-bridge.mjs";

const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (!args.includes("--outbox-dir") || !args.includes("--checkpoint-file")) throw new Error("Provide --outbox-dir and the producer's --checkpoint-file");
let checkpoint;
try { checkpoint = JSON.parse(await readFile(value("--checkpoint-file"), "utf8")); }
catch { console.error("Collector checkpoint could not be read"); process.exit(2); }
const result = await pruneCollectorSentryReceipts(value("--outbox-dir"), { successfulThrough: checkpoint.successfulThrough, retentionDays: args.includes("--retention-days") ? Number(value("--retention-days")) : 180 });
console.log(JSON.stringify(result));
