// The append-only journal and the per-destination read offsets.
//
// The journal is the hub's audit trail.  It holds the CONTENT, so it is a
// local file, and it is readable only by the user: the state directory is
// created with mode 700 and every file in it with mode 600.
//
// One JSON object per line, fsynced on write.  A crash can lose the tail of
// the file, never reorder it and never interleave two lines.
//
// Each destination (the UM turn channel, the UM ledger channel and Sentry)
// keeps its OWN read offset and its OWN set of already-sent event ids, in
// separate small state files.  A destination that is down therefore never
// holds the other one back.
//
// The offset advances ONLY after a successful delivery.  A crash between
// "delivered" and "offset advanced" would resend, so every sender also
// checks the sent set before it sends.  Sentry does not dedupe OTLP logs,
// which is why that check is not optional.

import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

import { NULL_LOGGER } from "./internal-event.mjs";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** How many already-sent event ids one destination remembers. */
export const MAX_SENT_IDS = 10_000;

/** Read chunk size when scanning the journal. */
const READ_CHUNK_BYTES = 256 * 1024;

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** A destination name becomes a file name, so it is restricted. */
export function normalizeDestination(name) {
  const value = String(name ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(value)) {
    throw new Error(`Invalid destination name: ${String(name).slice(0, 40)}`);
  }
  return value;
}

export class Journal {
  /**
   * @param {object} options
   * @param {string} options.dir       State directory.  Created with mode 700.
   * @param {object} [options.logger]
   */
  constructor({ dir, logger = NULL_LOGGER }) {
    if (typeof dir !== "string" || !dir.trim()) throw new Error("Journal dir is required");
    this.dir = dir;
    this.logger = logger;
    this.journalPath = join(dir, "journal.jsonl");
    this.stateDir = join(dir, "state");
    this.deadLetterPath = join(dir, "dead-letter.jsonl");
    this.handle = undefined;
    this.offsets = new Map();
    this.sentSets = new Map();
  }

  /** Create the directory tree with tight modes and open the journal. */
  async open() {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    await chmod(this.dir, DIR_MODE);
    await chmod(this.stateDir, DIR_MODE);
    this.handle = await open(this.journalPath, "a", FILE_MODE);
    await this.handle.chmod(FILE_MODE);
    return this;
  }

  /** Load the persisted offsets and sent sets for the known destinations. */
  async loadDestinations(destinations) {
    for (const raw of destinations) {
      const destination = normalizeDestination(raw);
      if (this.offsets.has(destination)) continue;
      this.offsets.set(destination, await this.readOffsetFile(destination));
      this.sentSets.set(destination, await this.readSentFile(destination));
    }
  }

  async readOffsetFile(destination) {
    try {
      const raw = await readFile(join(this.stateDir, `${destination}.offset.json`), "utf8");
      const parsed = JSON.parse(raw);
      const offset = Number(parsed?.offset);
      return Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    } catch {
      return 0;
    }
  }

  async readSentFile(destination) {
    try {
      const raw = await readFile(join(this.stateDir, `${destination}.sent.json`), "utf8");
      const parsed = JSON.parse(raw);
      const ids = Array.isArray(parsed?.eventIds) ? parsed.eventIds : [];
      return new Set(ids.filter((id) => typeof id === "string" && id));
    } catch {
      return new Set();
    }
  }

  /**
   * Append one internal event and fsync it.
   *
   * The line is serialized with JSON.stringify, so a newline inside a value
   * can never split the record across two lines.
   */
  async append(event) {
    if (!isPlainObject(event)) throw new Error("Journal append needs an object");
    if (!this.handle) throw new Error("Journal is not open");
    const line = `${JSON.stringify(event)}\n`;
    await this.handle.write(line, null, "utf8");
    await this.handle.sync();
    return Buffer.byteLength(line, "utf8");
  }

  /** The current read offset of one destination. */
  getOffset(destination) {
    const key = normalizeDestination(destination);
    return this.offsets.get(key) ?? 0;
  }

  /** Persist the read offset of one destination. */
  async setOffset(destination, offset) {
    const key = normalizeDestination(destination);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("Offset must be a non-negative integer");
    this.offsets.set(key, offset);
    await this.writeStateFile(key, `${key}.offset.json`, { offset });
  }

  /** True when this destination already delivered the event. */
  isSent(destination, eventId) {
    const key = normalizeDestination(destination);
    if (typeof eventId !== "string" || !eventId) return false;
    return (this.sentSets.get(key) ?? new Set()).has(eventId);
  }

  /** Record that this destination delivered the event. */
  async markSent(destination, eventId) {
    const key = normalizeDestination(destination);
    if (typeof eventId !== "string" || !eventId) return;
    let set = this.sentSets.get(key);
    if (!set) {
      set = new Set();
      this.sentSets.set(key, set);
    }
    if (set.has(eventId)) return;
    set.add(eventId);
    while (set.size > MAX_SENT_IDS) {
      const oldest = set.values().next().value;
      set.delete(oldest);
    }
    await this.writeStateFile(key, `${key}.sent.json`, { eventIds: [...set] });
  }

  /** Record a batch of delivered event ids. */
  async markSentBatch(destination, eventIds) {
    const key = normalizeDestination(destination);
    let set = this.sentSets.get(key);
    if (!set) {
      set = new Set();
      this.sentSets.set(key, set);
    }
    let changed = false;
    for (const eventId of eventIds) {
      if (typeof eventId !== "string" || !eventId || set.has(eventId)) continue;
      set.add(eventId);
      changed = true;
    }
    while (set.size > MAX_SENT_IDS) {
      const oldest = set.values().next().value;
      set.delete(oldest);
    }
    if (changed) {
      await this.writeStateFile(key, `${key}.sent.json`, { eventIds: [...set] });
    }
  }

  async writeStateFile(destination, fileName, payload) {
    const target = join(this.stateDir, fileName);
    const temporary = `${target}.tmp`;
    const body = `${JSON.stringify(payload)}\n`;
    await writeFile(temporary, body, { mode: FILE_MODE });
    await rename(temporary, target);
    await chmod(target, FILE_MODE);
  }

  /**
   * Read up to `limit` events for one destination, starting at its offset.
   *
   * Events this destination already sent are skipped, and the returned
   * `endOffset` points past every line that was consumed, so a skipped
   * event never blocks the ones behind it.
   *
   * A partial trailing line (a crash mid-write) is never parsed and never
   * counted, so the offset stays on a line boundary.
   */
  async readBatch(destination, limit) {
    const key = normalizeDestination(destination);
    const start = this.getOffset(key);
    const sent = this.sentSets.get(key) ?? new Set();
    const events = [];
    if (!this.handle && !(await this.exists())) {
      return { events, endOffset: start };
    }
    const file = await open(this.journalPath, fsConstants.O_RDONLY);
    try {
      const info = await file.stat();
      const size = info.size;
      if (start >= size) return { events, endOffset: start };
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      let pending = "";
      let pendingStart = start;
      let filePos = start;
      let endOffset = start;
      let done = false;
      while (!done && events.length < limit) {
        const remaining = size - filePos;
        if (remaining <= 0) break;
        const want = Math.min(READ_CHUNK_BYTES, remaining);
        const { bytesRead } = await file.read(buffer, 0, want, filePos);
        if (bytesRead <= 0) break;
        filePos += bytesRead;
        pending += decoder.write(buffer.subarray(0, bytesRead));
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline === -1) break;
          const line = pending.slice(0, newline);
          const consumed = Buffer.byteLength(line, "utf8") + 1;
          pending = pending.slice(newline + 1);
          pendingStart += consumed;
          endOffset = pendingStart;
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed = null;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            parsed = null;
          }
          if (!isPlainObject(parsed)) continue;
          if (typeof parsed.eventId === "string" && sent.has(parsed.eventId)) continue;
          events.push(parsed);
          if (events.length >= limit) break;
        }
      }
      return { events, endOffset };
    } finally {
      await file.close();
    }
  }

  async exists() {
    try {
      await stat(this.journalPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Quarantine one event into the dead-letter file.
   *
   * The record carries the event id, the metric type, the destination and a
   * reason.  It carries NO content: no prompt, no response, no tool
   * argument.  The journal itself stays the only place content lives.
   */
  async quarantine(destination, event, { reason, status } = {}) {
    const key = normalizeDestination(destination);
    const record = {
      quarantinedAt: new Date().toISOString(),
      destination: key,
      eventId: typeof event?.eventId === "string" ? event.eventId : "",
      metricType: typeof event?.operation === "string" ? event.operation : "",
      provider: typeof event?.provider === "string" ? event.provider : "",
      status: typeof event?.status === "string" ? event.status : "",
      reason: typeof reason === "string" ? reason.slice(0, 200) : "",
      httpStatus: Number.isInteger(status) ? status : undefined,
    };
    const line = `${JSON.stringify(record)}\n`;
    const file = await open(this.deadLetterPath, "a", FILE_MODE);
    try {
      await file.write(line, null, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    return record;
  }

  /** Close the journal handle. */
  async close() {
    if (this.handle) {
      await this.handle.close();
      this.handle = undefined;
    }
  }
}
