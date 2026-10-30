import { constants } from "node:fs";
import { open } from "node:fs/promises";

export async function openProtectedCleanupFile(path, { maxBytes = 256 * 1024 * 1024, requirePrivate = true } = {}) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat({ bigint: true });
    if (!info.isFile()) throw new Error("Cleanup input must be a regular file");
    if (requirePrivate && ((info.mode & 0o777n) !== 0o600n || info.uid !== BigInt(process.getuid()))) {
      throw new Error("Cleanup input must be mode600 and owned by this user");
    }
    if (maxBytes != null && info.size > BigInt(maxBytes)) throw new Error("Cleanup input exceeds the size limit");
    return { handle, info, requirePrivate };
  } catch (error) { await handle.close(); throw error; }
}

async function verifyUnchanged(file) {
  const after = await file.handle.stat({ bigint: true });
  if (file.info.size !== after.size || file.info.mtimeNs !== after.mtimeNs || file.info.ctimeNs !== after.ctimeNs ||
    (file.requirePrivate && ((after.mode & 0o777n) !== 0o600n || after.uid !== BigInt(process.getuid())))) {
    throw new Error("Cleanup input changed while being read");
  }
}

export async function readProtectedCleanupJsonHandle(file) {
  const buffer = Buffer.alloc(Number(file.info.size) + 1);
  let position = 0;
  while (position < buffer.length) {
    const { bytesRead } = await file.handle.read(buffer, position, buffer.length - position, position);
    if (!bytesRead) break;
    position += bytesRead;
  }
  await verifyUnchanged(file);
  if (position !== Number(file.info.size)) throw new Error("Cleanup input size changed while being read");
  try { return JSON.parse(buffer.subarray(0, position).toString("utf8")); }
  catch { throw new Error("Cleanup input is not valid JSON"); }
}

export async function readProtectedCleanupJson(path) {
  const file = await openProtectedCleanupFile(path);
  try { return await readProtectedCleanupJsonHandle(file); }
  finally { await file.handle.close(); }
}

export async function verifyProtectedSqliteBackup(path, livePath) {
  const backup = await openProtectedCleanupFile(path, { maxBytes: null });
  try {
    if (backup.info.size < 16n) throw new Error("Verified full database backup is empty");
    const header = Buffer.alloc(16);
    const { bytesRead } = await backup.handle.read(header, 0, 16, 0);
    await verifyUnchanged(backup);
    if (bytesRead !== 16 || !header.equals(Buffer.from("SQLite format 3\u0000"))) throw new Error("Full backup is not a SQLite snapshot");
    if (livePath) {
      const live = await openProtectedCleanupFile(livePath, { maxBytes: null, requirePrivate: false });
      try {
        if (backup.info.ino === live.info.ino && backup.info.dev === live.info.dev) throw new Error("Full backup must be separate from the live database");
      } finally { await live.handle.close(); }
    }
  } finally { await backup.handle.close(); }
}
