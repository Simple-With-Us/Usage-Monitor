import { readFile } from "node:fs/promises";
import path from "node:path";

const SUPPORTED_SIZES = new Set([192, 512]);

/**
 * PWA install icons — serve the same orange circuit/sync mark as the iOS
 * client AppIcon (files under public/brand/). Kept at /pwa-icon/:size so
 * the web manifest and middleware public-path allowlist stay stable.
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ size: string }> }
) {
  const { size: rawSize } = await context.params;
  const size = Number(rawSize);
  if (!Number.isInteger(size) || !SUPPORTED_SIZES.has(size)) {
    return new Response("Not found", { status: 404 });
  }

  const filePath = path.join(
    process.cwd(),
    "public",
    "brand",
    `icon-${size}.png`
  );
  let body: Buffer;
  try {
    body = await readFile(filePath);
  } catch {
    return new Response("Not found", { status: 404 });
  }

  return new Response(new Uint8Array(body), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=86400, stale-while-revalidate=604800",
    },
  });
}
