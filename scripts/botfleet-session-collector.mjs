import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { botFleetRuntimeTelemetry, projectBotFleetRuntimeEvent } from "./lib/botfleet-session-telemetry.mjs";
import { collectorSentryConfig, drainCollectorSentry, enqueueCollectorSentryTelemetry } from "./lib/collector-sentry-bridge.mjs";

/** Read retained native events without persisting or logging their content. */
export async function collectBotFleetSessionTelemetry({ eventsDir, producerInstanceId, since, until }) {
  if (!(since instanceof Date) || !(until instanceof Date)) throw new Error("Native telemetry requires an explicit operational window of 1 to 168 hours");
  const windowMs = until?.getTime() - since?.getTime();
  if (!Number.isFinite(windowMs) || windowMs < 3600000 || windowMs > 168 * 3600000) throw new Error("Native telemetry requires an explicit operational window of 1 to 168 hours");
  const stats = { sourceAvailable: true, sourceFiles: 0, malformedLines: 0, historyGaps: 0, readRaces: 0, retainedCompletions: 0, outsideLookbackCompletions: 0, afterWindowCompletions: 0 };
  let files;
  try { files = await readdir(eventsDir, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { events: [], stats: { ...stats, sourceAvailable: false } };
  }
  const records = [];
  const historyGapIds = new Set();
  for (const file of files.filter((entry) => entry.isFile() && /\.ndjson(?:\.1)?$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name))) {
    const input = createReadStream(join(eventsDir, file.name), { encoding: "utf8" });
    const lines = createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        let raw;
        try { raw = JSON.parse(line); } catch { stats.malformedLines += 1; continue; }
        if (raw?.type === "runtime.error" && raw.raw?.source === "botfleet.event-log" && typeof raw.eventId === "string") historyGapIds.add(raw.eventId);
        const selected = projectBotFleetRuntimeEvent(raw);
        if (selected) records.push(selected);
      }
      stats.sourceFiles += 1;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      stats.readRaces += 1;
    } finally {
      lines.close();
      input.destroy();
    }
  }
  records.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  stats.historyGaps = historyGapIds.size;
  const completions = new Map(records.filter((record) => record.type === "turn.completed").map((record) => [record.eventId, record.ts]));
  stats.retainedCompletions = completions.size;
  stats.outsideLookbackCompletions = [...completions.values()].filter((ts) => Date.parse(ts) < since.getTime()).length;
  stats.afterWindowCompletions = [...completions.values()].filter((ts) => Date.parse(ts) > until.getTime()).length;
  return { events: botFleetRuntimeTelemetry(records, { producerInstanceId, since, until }), stats };
}

export async function main(argv = process.argv.slice(2)) {
  let dryRun = false;
  let hours = Number(process.env.BOTFLEET_SENTRY_LOOKBACK_HOURS);
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--dry-run") dryRun = true;
    else if (argv[index] === "--hours") hours = Number(argv[++index]);
    else throw new Error("Use --dry-run and an explicit --hours value; configure the source through BOTFLEET_EVENTS_DIR");
  }
  const producerId = "botfleet";
  const producerInstanceId = process.env.USAGE_MACHINE_ID?.trim() || hostname();
  const config = dryRun ? null : collectorSentryConfig(process.env, producerId);
  if (!dryRun && !config) {
    console.log(JSON.stringify({ collector: "botfleet-native-sentry", enabled: false }));
    return;
  }
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > 168) throw new Error("Set an explicit operational lookback of 1 to 168 hours");
  const until = new Date();
  const since = new Date(until.getTime() - hours * 3600000);
  const { events, stats } = await collectBotFleetSessionTelemetry({ eventsDir: process.env.BOTFLEET_EVENTS_DIR || join(homedir(), ".botfleet", "events"), producerInstanceId, since, until });
  const summary = { collector: "botfleet-native-sentry", dryRun, lookbackHours: hours, ...stats, turns: events.length, spans: events.filter((event) => event.kind === "span").length, observations: events.filter((event) => event.kind === "log").length };
  if (config) {
    const root = await enqueueCollectorSentryTelemetry(events, { producerId, producerInstanceId }, config);
    Object.assign(summary, { spooled: true }, await drainCollectorSentry(root, config, { prioritizeUnnarrowed: true }));
  }
  console.log(JSON.stringify(summary));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Native BotFleet telemetry collection failed; source and durable outbox retained"); process.exitCode = 1; });
}
