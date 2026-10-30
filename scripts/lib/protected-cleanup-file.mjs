import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";

export function cleanupOwnerUid() {
  if (typeof process.getuid !== "function") {
    const error = new Error("POSIX ownership validation is required");
    error.name = "UnsupportedPlatformError";
    throw error;
  }
  return process.getuid();
}

export async function openProtectedCleanupFile(path, { maxBytes = 256 * 1024 * 1024, requirePrivate = true, followSymlinks = false } = {}) {
  const ownerUid = requirePrivate ? cleanupOwnerUid() : undefined;
  const handle = await open(path, constants.O_RDONLY | (followSymlinks ? 0 : constants.O_NOFOLLOW) | constants.O_NONBLOCK);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new Error("Cleanup input must be a regular file");
    if (requirePrivate && ((info.mode & 0o777n) !== 0o600n || info.uid !== BigInt(ownerUid))) {
      throw new Error("Cleanup input must be mode600 and owned by this user");
    }
    if (maxBytes != null && info.size > BigInt(maxBytes)) throw new Error("Cleanup input exceeds the size limit");
    return { handle, info, requirePrivate, ownerUid };
  } catch (error) { await handle.close(); throw error; }
}

async function verifyUnchanged(file) {
  const after = await file.handle.stat({ bigint: true });
  if (file.info.size !== after.size || file.info.mtimeNs !== after.mtimeNs || file.info.ctimeNs !== after.ctimeNs ||
    (file.requirePrivate && ((after.mode & 0o777n) !== 0o600n || after.uid !== BigInt(file.ownerUid)))) {
    throw new Error("Cleanup input changed while being read");
  }
}

export async function readProtectedCleanupJsonHandle(file, { withDigest = false } = {}) {
  const buffer = Buffer.alloc(Number(file.info.size) + 1);
  let position = 0;
  while (position < buffer.length) {
    const { bytesRead } = await file.handle.read(buffer, position, buffer.length - position, position);
    if (!bytesRead) break;
    position += bytesRead;
  }
  await verifyUnchanged(file);
  if (position !== Number(file.info.size)) throw new Error("Cleanup input size changed while being read");
  try {
    const value = JSON.parse(buffer.subarray(0, position).toString("utf8"));
    return withDigest ? { value, bytes: position, sha256: createHash("sha256").update(buffer.subarray(0, position)).digest("hex") } : value;
  }
  catch { throw new Error("Cleanup input is not valid JSON"); }
}

export async function readProtectedCleanupJson(path, options) {
  const file = await openProtectedCleanupFile(path);
  try { return await readProtectedCleanupJsonHandle(file, options); }
  finally { await file.handle.close(); }
}

export async function verifyProtectedSqliteBackup(path, livePath, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? "")) throw new Error("Reviewed full backup checksum required");
  const backup = await openProtectedCleanupFile(path, { maxBytes: null });
  try {
    if (backup.info.size < 16n) throw new Error("Verified full database backup is empty");
    const header = Buffer.alloc(16);
    const { bytesRead } = await backup.handle.read(header, 0, 16, 0);
    await verifyUnchanged(backup);
    if (bytesRead !== 16 || !header.equals(Buffer.from("SQLite format 3\u0000"))) throw new Error("Full backup is not a SQLite snapshot");
    if (livePath) {
      const live = await openProtectedCleanupFile(livePath, { maxBytes: null, requirePrivate: false, followSymlinks: true });
      try {
        if (backup.info.ino === live.info.ino && backup.info.dev === live.info.dev) throw new Error("Full backup must be separate from the live database");
      } finally { await live.handle.close(); }
    }
    const hash = createHash("sha256"), chunk = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < Number(backup.info.size)) {
      const { bytesRead } = await backup.handle.read(chunk, 0, Math.min(chunk.length, Number(backup.info.size) - offset), offset);
      if (!bytesRead) throw new Error("Backup size changed while hashing");
      hash.update(chunk.subarray(0, bytesRead)); offset += bytesRead;
    }
    await verifyUnchanged(backup);
    const sha256 = hash.digest("hex");
    if (sha256 !== expectedSha256) throw new Error("Full backup checksum differs from reviewed checksum");
    return sha256;
  } finally { await backup.handle.close(); }
}
