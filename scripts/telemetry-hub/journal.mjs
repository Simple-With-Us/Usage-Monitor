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
//
// The offset is an ABSOLUTE byte position in the logical journal stream.
// The file on disk only holds the part of the stream that is not consumed
// yet: once the file grows past MAX_JOURNAL_BYTES, the prefix that every
// destination has already read is dropped and the base of the file moves
// forward.  The offsets themselves never change, so a compaction can
// neither lose nor replay an event.  The prefix that is dropped is a whole
// number of lines, because every offset sits on a line boundary.
//
// Every persisted state file and every journal row is validated with Zod
// before it is used.  A malformed state file is rejected instead of being
// half believed, and a malformed row is dropped instead of reaching a
// sender with an invalid identity.
//
// Zod is a runtime dependency of this repository.  The hub therefore has one
// third-party import, and it is on the parsing boundary, where an explicit
// runtime shape guard belongs.

import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";

import { NULL_LOGGER } from "./internal-event.mjs";

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** How many already-sent event ids one destination remembers. */
export const MAX_SENT_IDS = 10_000;

/** The journal file is compacted once it grows past this size. */
export const MAX_JOURNAL_BYTES = 32 * 1024 * 1024;

/** Read chunk size when scanning the journal. */
const READ_CHUNK_BYTES = 256 * 1024;

/** The file that records where the journal file starts in the stream. */
const BASE_FILE = "journal.base.json";

/** The persisted read offset of one destination. */
const OffsetStateSchema = z.object({
  offset: z.number().int().nonnegative(),
});

/** The persisted set of delivered event ids of one destination. */
const SentStateSchema = z.object({
  eventIds: z.array(z.string().min(1).max(256)).max(MAX_SENT_IDS),
});

/**
 * One journal row.
 *
 * The identity fields are required: a row without an event id cannot be
 * deduplicated and a row without a timestamp cannot be ordered.  The rest
 * of the row is the internal event, which is passed through as it is.
 */
const JournalEventSchema = z.looseObject({
  eventId: z.string().min(1).max(256),
  ts: z.string().min(1).max(64),
  kind: z.enum(["span", "log"]).optional(),
  platform: z.string().max(200).optional(),
});

/** The compaction bookkeeping of the journal file. */
const BaseStateSchema = z.object({
  base: z.number().int().nonnegative(),
  nextBase: z.number().int().nonnegative(),
  pendingSize: z.number().int().nonnegative(),
});

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A tiny promise mutex.
 *
 * Two places must not interleave: the appends and the compaction of the
 * journal file, and the writes of the per-destination state files.  Each
 * one gets its own mutex.
 */
function createMutex() {
  let tail = Promise.resolve();
  return function run(task) {
    const result = tail.then(task, task);
    tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
}

/**
 * The id of an event, when the event carries a valid one.
 *
 * The journal validates every row before a sender can see it, so this is
 * the second guard for a caller that maps ids out of an event.
 */
export function eventIdOf(event) {
  const checked = JournalEventSchema.safeParse(event);
  return checked.success ? checked.data.eventId : undefined;
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
   * @param {number} [options.maxJournalBytes]  The size the journal file
   *        passes before the consumed prefix is dropped.
   */
  constructor({ dir, logger = NULL_LOGGER, maxJournalBytes = MAX_JOURNAL_BYTES } = {}) {
    if (typeof dir !== "string" || !dir.trim()) throw new Error("Journal dir is required");
    this.dir = dir;
    this.logger = logger;
    this.maxJournalBytes = Number.isSafeInteger(maxJournalBytes) && maxJournalBytes > 0
      ? maxJournalBytes
      : MAX_JOURNAL_BYTES;
    this.journalPath = join(dir, "journal.jsonl");
    this.stateDir = join(dir, "state");
    this.deadLetterPath = join(dir, "dead-letter.jsonl");
    this.handle = undefined;
    this.offsets = new Map();
    this.sentSets = new Map();
    //  The absolute byte position of the first retained byte of the file.
    this.base = 0;
    this.fileMutex = createMutex();
    this.stateMutex = createMutex();
    this.writeCounter = 0;
  }

  /** Create the directory tree with tight modes and open the journal. */
  async open() {
    await mkdir(this.stateDir, { recursive: true, mode: DIR_MODE });
    await chmod(this.dir, DIR_MODE);
    await chmod(this.stateDir, DIR_MODE);
    await this.recoverBase();
    this.handle = await open(this.journalPath, "a", FILE_MODE);
    await this.handle.chmod(FILE_MODE);
    return this;
  }

  /**
   * Read the compaction bookkeeping and settle an interrupted compaction.
   *
   * The base file records the base of the file, the base the file WILL have
   * after a compaction, and the size the file had before that compaction.
   * A compaction interrupted after the swap left a file that is smaller
   * than the recorded size, so the new base is the right one.  A compaction
   * interrupted before the swap left the file untouched, so the old base is
   * the right one.
   */
  async recoverBase() {
    const state = await this.readBaseFile();
    let base = 0;
    if (state) {
      if (state.pendingSize > 0) {
        const size = await this.fileSize();
        base = size < state.pendingSize ? state.nextBase : state.base;
      } else {
        base = state.base;
      }
    }
    this.base = base;
    await this.writeBaseFile({ base, nextBase: base, pendingSize: 0 });
    return base;
  }

  async readBaseFile() {
    try {
      const raw = await readFile(join(this.stateDir, BASE_FILE), "utf8");
      const parsed = BaseStateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger.warn("the journal base state is not usable", { file: BASE_FILE });
        return null;
      }
      return parsed.data;
    } catch {
      return null;
    }
  }

  async writeBaseFile(state) {
    const target = join(this.stateDir, BASE_FILE);
    const temporary = this.tempPath(target);
    const body = `${JSON.stringify(state)}\n`;
    await writeFile(temporary, body, { mode: FILE_MODE });
    await rename(temporary, target);
    await chmod(target, FILE_MODE);
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
      const parsed = OffsetStateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger.warn("the offset state is not usable", { destination });
        return 0;
      }
      return parsed.data.offset;
    } catch {
      return 0;
    }
  }

  async readSentFile(destination) {
    try {
      const raw = await readFile(join(this.stateDir, `${destination}.sent.json`), "utf8");
      const parsed = SentStateSchema.safeParse(JSON.parse(raw));
      if (!parsed.success) {
        this.logger.warn("the sent state is not usable", { destination });
        return new Set();
      }
      return new Set(parsed.data.eventIds);
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
    return this.appendBatch([event]);
  }

  /**
   * Append a batch of internal events with ONE write and ONE fsync.
   *
   * A receiver request can carry a hundred events.  Flushing once per event
   * turns one request into a hundred disk flushes and delays the response,
   * which invites the producer to retry and duplicate the spans.
   */
  async appendBatch(events) {
    const list = Array.isArray(events) ? events : [];
    if (list.length === 0) return 0;
    for (const event of list) {
      if (!isPlainObject(event)) throw new Error("Journal append needs an object");
    }
    const body = `${list.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const bytes = Buffer.byteLength(body, "utf8");
    await this.fileMutex(async () => {
      if (!this.handle) throw new Error("Journal is not open");
      await this.handle.write(body, null, "utf8");
      await this.handle.sync();
    });
    await this.maybeCompact();
    return bytes;
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
    await this.stateMutex(async () => {
      this.offsets.set(key, offset);
      await this.writeStateFile(`${key}.offset.json`, { offset });
    });
    await this.maybeCompact();
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
    await this.stateMutex(async () => {
      const set = this.sentSet(key);
      if (set.has(eventId)) return;
      set.add(eventId);
      this.trimSentSet(set);
      await this.writeStateFile(`${key}.sent.json`, { eventIds: [...set] });
    });
  }

  /** Record a batch of delivered event ids. */
  async markSentBatch(destination, eventIds) {
    const key = normalizeDestination(destination);
    await this.stateMutex(async () => {
      const set = this.sentSet(key);
      let changed = false;
      for (const eventId of eventIds) {
        if (typeof eventId !== "string" || !eventId || set.has(eventId)) continue;
        set.add(eventId);
        changed = true;
      }
      this.trimSentSet(set);
      if (changed) {
        await this.writeStateFile(`${key}.sent.json`, { eventIds: [...set] });
      }
    });
  }

  sentSet(key) {
    let set = this.sentSets.get(key);
    if (!set) {
      set = new Set();
      this.sentSets.set(key, set);
    }
    return set;
  }

  trimSentSet(set) {
    while (set.size > MAX_SENT_IDS) {
      const oldest = set.values().next().value;
      set.delete(oldest);
    }
  }

  /**
   * Write one state file.
   *
   * The temporary path is unique per write, so two concurrent writes can
   * never truncate the same temporary file, and the rename that publishes
   * the file is atomic.
   */
  async writeStateFile(fileName, payload) {
    const target = join(this.stateDir, fileName);
    const temporary = this.tempPath(target);
    const body = `${JSON.stringify(payload)}\n`;
    await writeFile(temporary, body, { mode: FILE_MODE });
    await rename(temporary, target);
    await chmod(target, FILE_MODE);
  }

  /** A temporary path that no other write can collide with. */
  tempPath(target) {
    this.writeCounter += 1;
    return `${target}.${process.pid}.${this.writeCounter}.tmp`;
  }

  /**
   * Read up to `limit` events for one destination, starting at its offset.
   *
   * Events this destination already sent are skipped, and the returned
   * `endOffset` points past every line that was consumed, so a skipped
   * event never blocks the ones behind it.  A repeated event id inside one
   * batch is skipped as well, so one turn is never delivered twice.
   *
   * A partial trailing line (a crash mid-write) is never parsed and never
   * counted, so the offset stays on a line boundary.
   *
   * A row that does not match the journal schema is dropped: it cannot be
   * deduplicated and it must not reach a sender.
   */
  async readBatch(destination, limit) {
    const key = normalizeDestination(destination);
    const start = this.getOffset(key);
    const sent = this.sentSets.get(key) ?? new Set();
    const events = [];
    if (!this.handle && !(await this.exists())) {
      return { events, endOffset: start };
    }
    //  The base and the file are taken together, under the file mutex, so
    //  a compaction cannot slip between them.  A compaction that runs
    //  after this point replaces the file, but the handle below still
    //  points at the file this read belongs to, so the positions of this
    //  read and the base of this read always belong together.
    const opened = await this.fileMutex(async () => {
      const base = this.base;
      const file = await open(this.journalPath, fsConstants.O_RDONLY);
      let size;
      try {
        size = (await file.stat()).size;
      } catch (error) {
        //  The handle is only closed by the `finally` below once it has
        //  been handed out, so a failure here has to close it itself.
        //  Otherwise every read that fails after the open leaks a
        //  descriptor until the process runs out of them.
        await file.close();
        throw error;
      }
      return { base, file, size };
    });
    const { base, file, size } = opened;
    try {
      const fileStart = Math.max(0, start - base);
      if (fileStart >= size) return { events, endOffset: start };
      const decoder = new StringDecoder("utf8");
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      const seen = new Set();
      let pending = "";
      let pendingStart = fileStart;
      let filePos = fileStart;
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
          endOffset = base + pendingStart;
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed = null;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            parsed = null;
          }
          const checked = JournalEventSchema.safeParse(parsed);
          if (!checked.success) continue;
          const event = checked.data;
          if (sent.has(event.eventId)) continue;
          if (seen.has(event.eventId)) continue;
          seen.add(event.eventId);
          events.push(event);
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

  /** The size of the journal file on disk. */
  async fileSize() {
    try {
      const info = await stat(this.journalPath);
      return info.size;
    } catch {
      return 0;
    }
  }

  /** The smallest offset of every known destination. */
  minimumOffset() {
    if (this.offsets.size === 0) return undefined;
    let min = Infinity;
    for (const offset of this.offsets.values()) {
      if (offset < min) min = offset;
    }
    return Number.isFinite(min) ? min : undefined;
  }

  /**
   * Drop the part of the journal every destination has already read.
   *
   * The offsets are absolute, so removing a prefix does not change them:
   * only the base of the file moves.  The region that is removed is the
   * part below the smallest offset, so no destination can lose an event it
   * has not read yet.  A destination that is down keeps the journal from
   * shrinking, which is the price of not dropping its events.
   */
  async maybeCompact() {
    const target = this.minimumOffset();
    if (target === undefined) return false;
    if (target <= this.base) return false;
    const size = await this.fileSize();
    if (size <= this.maxJournalBytes) return false;
    //  The compaction rewrites the whole remaining file, so it is only
    //  worth its copy when the consumed prefix is a real part of the file.
    //  While the unconsumed backlog is still over the cap the rewrite
    //  cannot bring the file under it, so skipping keeps the write
    //  amplification at 2x instead of copying the whole file for every
    //  byte a slow destination consumes.
    //  The skip is NOT unbounded, though: once the consumed prefix is at
    //  least half the file the copy pays for itself, so the file still
    //  shrinks.  That bounds the file at 2x the unconsumed backlog, which
    //  is the smallest it can ever be while that backlog is retained.
    const prefix = Math.min(target - this.base, size);
    const remaining = size - prefix;
    if (remaining >= this.maxJournalBytes && prefix * 2 < size) return false;
    await this.compactTo(target);
    return true;
  }

  /** Rewrite the journal file without the consumed prefix. */
  async compactTo(target) {
    await this.fileMutex(async () => {
      const size = await this.fileSize();
      const cut = Math.min(target - this.base, size);
      if (cut <= 0) return;
      const temporary = `${this.journalPath}.compact`;
      if (cut >= size) {
        await writeFile(temporary, "", { mode: FILE_MODE });
      } else {
        await this.copyRange(this.journalPath, temporary, cut, size);
      }
      //  The pending record is written BEFORE the swap, so a crash in
      //  between leaves enough information to settle the outcome.
      await this.writeBaseFile({ base: this.base, nextBase: target, pendingSize: size });
      await rename(temporary, this.journalPath);
      await chmod(this.journalPath, FILE_MODE);
      await this.writeBaseFile({ base: target, nextBase: target, pendingSize: 0 });
      this.base = target;
      if (this.handle) {
        await this.handle.close();
        this.handle = undefined;
      }
      this.handle = await open(this.journalPath, "a", FILE_MODE);
      await this.handle.chmod(FILE_MODE);
    });
  }

  /** Copy a byte range of one file into another file. */
  async copyRange(source, target, from, to) {
    const input = await open(source, fsConstants.O_RDONLY);
    const output = await open(target, "w", FILE_MODE);
    try {
      const buffer = Buffer.alloc(READ_CHUNK_BYTES);
      let position = from;
      while (position < to) {
        const want = Math.min(READ_CHUNK_BYTES, to - position);
        const { bytesRead } = await input.read(buffer, 0, want, position);
        if (bytesRead <= 0) break;
        await output.write(buffer.subarray(0, bytesRead), 0, bytesRead, position - from);
        position += bytesRead;
      }
      await output.sync();
    } finally {
      await output.close();
      await input.close();
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
