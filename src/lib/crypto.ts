import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const JSON_ENVELOPE_VERSION = "v1";

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }
  // Must be 32 bytes (64 hex characters) for AES-256
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error(
      "ENCRYPTION_KEY must be a 64-character hex string (32 bytes)"
    );
  }
  return Buffer.from(key, "hex");
}

export function encrypt(text: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag();
  // Format: iv:authTag:ciphertext (all hex)
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted}`;
}

export function decrypt(encrypted: string): string {
  const key = getEncryptionKey();
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted text format");
  }
  const [ivHex, authTagHex, ciphertext] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(ciphertext, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

/** Encrypt a JSON object in a versioned envelope so future key/envelope
 * migrations can be distinguished from the legacy API-key ciphertext format.
 */
export function encryptJson(value: Record<string, unknown>): string {
  return `${JSON_ENVELOPE_VERSION}:${encrypt(JSON.stringify(value))}`;
}

export function decryptJson(envelope: string): Record<string, unknown> {
  const separator = envelope.indexOf(":");
  if (separator === -1) {
    throw new Error("Invalid encrypted JSON envelope");
  }

  const version = envelope.slice(0, separator);
  if (version !== JSON_ENVELOPE_VERSION) {
    throw new Error(`Unsupported encrypted JSON envelope version: ${version}`);
  }

  const value: unknown = JSON.parse(decrypt(envelope.slice(separator + 1)));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Encrypted JSON payload must be an object");
  }
  return value as Record<string, unknown>;
}
