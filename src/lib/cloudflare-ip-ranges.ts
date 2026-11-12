/**
 * Cloudflare's published edge IP ranges (https://www.cloudflare.com/ips/).
 *
 * Used to decide whether a request's immediate peer - the rightmost
 * X-Forwarded-For hop, i.e. the one our own reverse proxy (Render) appended
 * from its own TCP observation - actually terminated at Cloudflare. Only
 * when that's true is `CF-Connecting-IP` on the same request Cloudflare-set
 * rather than an ordinary, client-controlled header: Cloudflare overwrites
 * this header itself from the TLS-terminated connection at its edge, but
 * that guarantee only holds for traffic that genuinely passed through
 * Cloudflare. A client connecting directly to the origin (bypassing
 * Cloudflare entirely) can set `CF-Connecting-IP` to anything, including a
 * fresh value on every request.
 *
 * This list changes rarely - Cloudflare adds or retires ranges on the order
 * of once every year or two. Staleness degrades gracefully: an unrecognized
 * *new* Cloudflare range is simply treated as "not Cloudflare" and falls
 * back to the same rightmost-hop-only trust this app used before this
 * allowlist existed. That's never a new hole, only a reversion to prior
 * behavior for the affected range.
 */
const CLOUDFLARE_IPV4_CIDRS = [
  "173.245.48.0/20",
  "103.21.244.0/22",
  "103.22.200.0/22",
  "103.31.4.0/22",
  "141.101.64.0/18",
  "108.162.192.0/18",
  "190.93.240.0/20",
  "188.114.96.0/20",
  "197.234.240.0/22",
  "198.41.128.0/17",
  "162.158.0.0/15",
  "104.16.0.0/13",
  "104.24.0.0/14",
  "172.64.0.0/13",
  "131.0.72.0/22",
];

const CLOUDFLARE_IPV6_CIDRS = [
  "2400:cb00::/32",
  "2606:4700::/32",
  "2803:f800::/32",
  "2405:b500::/32",
  "2405:8100::/32",
  "2a06:98c0::/29",
  "2c0f:f248::/32",
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

function ipv6ToBigInt(ip: string): bigint | null {
  const trimmed = ip.trim();
  if (!trimmed.includes(":")) return null;

  const doubleColonCount = (trimmed.match(/::/g) || []).length;
  if (doubleColonCount > 1) return null;

  let head: string[];
  let tail: string[];
  if (trimmed.includes("::")) {
    const [left, right] = trimmed.split("::");
    head = left ? left.split(":") : [];
    tail = right ? right.split(":") : [];
  } else {
    head = trimmed.split(":");
    tail = [];
  }

  const missing = 8 - (head.length + tail.length);
  if (missing < 0) return null;
  const hextets = [...head, ...Array(missing).fill("0"), ...tail];
  if (hextets.length !== 8) return null;

  let result = BigInt(0);
  for (const hextet of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(hextet)) return null;
    result = (result << BigInt(16)) | BigInt(parseInt(hextet, 16));
  }
  return result;
}

function inCidrV4(ip: number, cidr: string): boolean {
  const [base, prefixRaw] = cidr.split("/");
  const baseInt = ipv4ToInt(base);
  const prefixLen = Number(prefixRaw);
  if (baseInt === null) return false;
  if (prefixLen === 0) return true;
  const mask = prefixLen >= 32 ? 0xffffffff : (~0 << (32 - prefixLen)) >>> 0;
  return (ip & mask) === (baseInt & mask);
}

function inCidrV6(ip: bigint, cidr: string): boolean {
  const [base, prefixRaw] = cidr.split("/");
  const baseInt = ipv6ToBigInt(base);
  const prefixLen = Number(prefixRaw);
  if (baseInt === null) return false;
  if (prefixLen === 0) return true;
  const mask =
    (BigInt(-1) << BigInt(128 - prefixLen)) & ((BigInt(1) << BigInt(128)) - BigInt(1));
  return (ip & mask) === (baseInt & mask);
}

/**
 * Returns true if `ip` falls within one of Cloudflare's published edge
 * IPv4/IPv6 ranges. Malformed or empty input returns false (never throws).
 */
export function isCloudflareIp(ip: string): boolean {
  const trimmed = ip.trim();
  if (!trimmed) return false;

  const v4 = ipv4ToInt(trimmed);
  if (v4 !== null) {
    return CLOUDFLARE_IPV4_CIDRS.some((cidr) => inCidrV4(v4, cidr));
  }

  const v6 = ipv6ToBigInt(trimmed);
  if (v6 !== null) {
    return CLOUDFLARE_IPV6_CIDRS.some((cidr) => inCidrV6(v6, cidr));
  }

  return false;
}
