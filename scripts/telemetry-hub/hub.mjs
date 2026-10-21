#!/usr/bin/env node
// The telemetry hub entry point.
//
// One process on the Mac.  It receives OTLP from local producers on
// 127.0.0.1:4318, journals every signal, and delivers the journal to two
// destinations with two different content policies:
//
//   Usage Monitor   everything, including the prompt and the response
//   Sentry          counts, durations, model, tool names and status only
//
// The scrubber that enforces the Sentry policy lives in ./allowlist.mjs.
//
// ONE tick at a time.  A delivery pass can take far longer than the tick
// interval, so the pass carries an in-flight guard: a second pass never
// starts on top of the first one, so no event is delivered twice and no
// two passes write the same offset file at the same time.
//
// Usage:
//   node scripts/telemetry-hub/hub.mjs [--dry-run] [--state-dir <path>]
//        [--port <n>] [--um-base-url <url>] [--sentry-endpoint <url>]
//        [--once] [--no-receiver]
//
// `--dry-run` writes NOTHING to the network.  It still accepts local
// telemetry and journals it, it never advances a delivery offset, and it
// prints counts and key names only.  It never prints a producer value.

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { createLogger } from "./internal-event.mjs";
import { Journal } from "./journal.mjs";
import { createReceiver } from "./otlp-receiver.mjs";
import { createSentrySender } from "./sentry-sender.mjs";
import { createUmSender } from "./um-sender.mjs";

const DEFAULT_STATE_DIR = join(homedir(), ".local", "state", "telemetry-hub");
const DRY_RUN_STATE_SUFFIX = "-dry-run";
const DEFAULT_TICK_MS = 10_000;

function parseArgs(argv) {
  const options = {
    dryRun: false,
    stateDir: undefined,
    port: 4318,
    umBaseUrl: undefined,
    sentryEndpoint: undefined,
    once: false,
    receiver: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => argv[index + 1];
    if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--once") options.once = true;
    else if (arg === "--no-receiver") options.receiver = false;
    else if (arg === "--state-dir") {
      options.stateDir = next();
      index += 1;
    } else if (arg === "--um-base-url") {
      options.umBaseUrl = next();
      index += 1;
    } else if (arg === "--sentry-endpoint") {
      options.sentryEndpoint = next();
      index += 1;
    } else if (arg === "--port") {
      const port = Number(next());
      if (Number.isInteger(port) && port > 0 && port < 65536) options.port = port;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    }
  }
  return options;
}

const USAGE = [
  "telemetry-hub -- local OTLP receiver with a scrubbed Sentry path and a full-fidelity UM path",
  "",
  "  --dry-run              journal and count only, never write to the network",
  "  --state-dir <path>     the journal and the per-destination state",
  "  --port <n>             the OTLP receiver port (default 4318)",
  "  --um-base-url <url>    the Usage Monitor base URL",
  "  --sentry-endpoint <u>  the Sentry OTLP endpoint, ending in /integration/otlp",
  "  --once                 run one delivery pass and exit",
  "  --no-receiver          do not open the local OTLP listener",
].join("\n");

/**
 * Run one delivery pass over both destinations.
 *
 * The two senders run CONCURRENTLY, so a destination that is down never
 * holds the other one back.
 */
export async function runDeliveryPass({ umSender, sentrySender, logger }) {
  const results = await Promise.allSettled([umSender.runOnce(), sentrySender.runOnce()]);
  const um = results[0];
  const sentry = results[1];
  if (um.status === "rejected") {
    logger.error("the um sender failed", { errorName: um.reason?.name ?? "Error" });
  }
  if (sentry.status === "rejected") {
    logger.error("the sentry sender failed", { errorName: sentry.reason?.name ?? "Error" });
  }
  return { um, sentry };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }

  const logger = createLogger();
  const stateDir = options.stateDir
    ? options.stateDir
    : options.dryRun
      ? `${DEFAULT_STATE_DIR}${DRY_RUN_STATE_SUFFIX}`
      : DEFAULT_STATE_DIR;

  const journal = new Journal({ dir: stateDir, logger });
  await journal.open();

  const umSender = createUmSender({
    journal,
    baseUrl: options.umBaseUrl?.trim() || process.env.UM_BASE_URL?.trim() || undefined,
    dryRun: options.dryRun,
    logger,
  });
  const sentrySender = createSentrySender({
    journal,
    endpoint: options.sentryEndpoint ?? process.env.SENTRY_OTLP_ENDPOINT?.trim() ?? undefined,
    publicKey: process.env.SENTRY_PUBLIC_KEY?.trim() ?? undefined,
    dryRun: options.dryRun,
    logger,
  });

  await journal.loadDestinations([...umSender.destinations, ...sentrySender.destinations]);

  let receiver;
  if (options.receiver) {
    receiver = createReceiver({ journal, logger, port: options.port });
    await receiver.listen();
    logger.info("the otlp receiver is listening", { host: receiver.host, port: options.port });
  }

  logger.info("the telemetry hub is running", {
    dryRun: options.dryRun,
    stateDir,
    tickMs: DEFAULT_TICK_MS,
  });

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (receiver) await receiver.close();
    await journal.close();
  };
  process.on("SIGINT", () => {
    void stop().then(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    void stop().then(() => process.exit(0));
  });

  if (options.once) {
    await runDeliveryPass({ umSender, sentrySender, logger });
    await stop();
    return 0;
  }

  //  A pass can take far longer than the tick: three attempts with a
  //  twenty second timeout and a backoff, per chunk, per destination.  The
  //  in-flight flag keeps a second pass from starting on top of the first
  //  one, so no event is delivered twice and no two passes write the same
  //  offset file at the same time.
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void runDeliveryPass({ umSender, sentrySender, logger }).finally(() => {
      inFlight = false;
    });
  }, DEFAULT_TICK_MS);
  timer.unref?.();

  await new Promise((resolve) => {
    process.on("SIGINT", resolve);
    process.on("SIGTERM", resolve);
  });
  clearInterval(timer);
  await stop();
  return 0;
}

const invokedDirectly = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;
if (invokedDirectly) {
  main().then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (error) => {
      // The message of an unexpected error can quote a payload, so only the
      // error NAME is reported.
      process.stderr.write(`${JSON.stringify({ level: "error", message: "the hub stopped", name: error?.name ?? "Error" })}\n`);
      process.exit(1);
    },
  );
}
