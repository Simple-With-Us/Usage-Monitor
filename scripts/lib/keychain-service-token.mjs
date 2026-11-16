import { execFileSync } from "node:child_process";

/**
 * The owner's login keychain holds one generic-password item per scoped
 * Infisical service token:  the service is KEYCHAIN_SERVICE and the account
 * is the token's registry name, so a reader holding the registry row finds
 * the item by that name.  The value is NOT in the environment, NOT in a file
 * on disk and NOT in the shared `fleet-secrets` reader:  the token is what
 * this consumer is allowed to read, and a store only this consumer reads
 * keeps it that narrow.
 *
 * The login keychain is reachable only from the owner's GUI session.  A
 * launchd agent bootstrapped into gui/$(id -u) is in that session;  a plain
 * shell over SSH is not, and `security` there answers "User interaction is
 * not allowed".  A consumer outside the GUI session therefore fails closed
 * with "keychain-locked" rather than reaching for another credential.
 */
export const KEYCHAIN_SERVICE = "infisical-service-token";

/** `security` is at a fixed absolute path:  a LaunchAgent's PATH is minimal. */
export const SECURITY_BIN = "/usr/bin/security";

/**
 * `security find-generic-password` exit codes.  44 is errSecItemNotFound
 * (there is no such item) and 36 is errSecInteractionNotAllowed (the
 * keychain is locked, or the caller is outside the owner's GUI session).
 * Both are refusals, and a reader has to be able to tell them apart.
 */
export const SECURITY_ITEM_NOT_FOUND = 44;
export const SECURITY_INTERACTION_NOT_ALLOWED = 36;

/** A token account is a plain registry name;  anything else is refused
 * before a process is spawned, so a name can never become a `security` flag. */
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Classify a failed keychain read without ever surfacing the item's
 * attributes.  `security` prints item attributes on stderr for some
 * failures, so stderr is used only to recognise the two known refusals and
 * is never echoed into an error message or a log line.
 */
function classifyKeychainFailure(error) {
  const status = error?.status;
  if (status === SECURITY_ITEM_NOT_FOUND) return "no-token";
  if (status === SECURITY_INTERACTION_NOT_ALLOWED) return "keychain-locked";
  const detail = String(error?.stderr ?? "").toLowerCase();
  if (detail.includes("could not be found")) return "no-token";
  if (detail.includes("interaction is not allowed")) return "keychain-locked";
  return "token-unreadable";
}

/**
 * Read one scoped Infisical service token from the owner's login keychain.
 *
 * Returns `{ token, status }`.  The token is "" for every refusal, exactly
 * as the retired plaintext file read was;  the status says WHICH refusal it
 * was -- "ok" (the token was read), "no-token" (there is no such item in the
 * keychain), "keychain-locked" (the keychain refused the read, because it is
 * locked or the caller is outside the owner's GUI session) or
 * "token-unreadable" (the item is there but the read failed) -- because a
 * collector that skipped its pass for one of those reasons has to be able to
 * tell the owner which one it was.
 *
 * The token value is never printed, logged or echoed.  A 0600 file is
 * staging only:  it is how a value is handed to the keychain, and it is
 * deleted once the keychain item is in place.
 *
 * The `exec` seam is the only way this function touches the keychain, so a
 * test can supply a stand-in for `security` and never read the real one.
 */
export function readKeychainServiceToken(
  account,
  { exec = execFileSync, securityBin = SECURITY_BIN, timeout = 30_000 } = {},
) {
  if (!ACCOUNT_PATTERN.test(String(account ?? ""))) return { token: "", status: "no-token" };
  let stdout;
  try {
    stdout = exec(
      securityBin,
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout,
        maxBuffer: 64 * 1024,
      },
    );
  } catch (error) {
    return { token: "", status: classifyKeychainFailure(error) };
  }
  const token = typeof stdout === "string" ? stdout.trim() : "";
  return token ? { token, status: "ok" } : { token: "", status: "no-token" };
}
