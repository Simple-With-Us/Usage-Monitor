// Streaming, size-bounded request body reader shared by every ingest
// endpoint. Route handlers previously called `await request.json()`
// directly, which buffers the entire body in memory (and lets Node grow
// that buffer arbitrarily) before any application-level validation runs.
// An authenticated-but-oversized payload — or, on routes that read the
// body before checking auth, an unauthenticated one — could balloon
// process memory well before `parseUsageTelemetryBatch`'s own field limits
// ever get a chance to reject it. This reader enforces a byte ceiling
// during the read itself, aborting the stream (and returning HTTP 413 via
// RequestBodyTooLargeError) before a too-large body is ever assembled.
export class RequestBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(label: string, maxBytes: number) {
    super(`${label} exceeds ${maxBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export async function readBoundedRequestBody(
  request: Request,
  options: { maxBytes: number; label: string }
): Promise<Uint8Array> {
  const { maxBytes, label } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("Request body limit must be a positive safe integer");
  }

  // Fast path: a declared Content-Length lets us reject before reading any
  // bytes at all. Still fall through to the streaming check below, since a
  // client can lie about (or omit) Content-Length.
  const contentLength = request.headers.get("content-length");
  if (contentLength) {
    const declared = Number(contentLength);
    if (!Number.isSafeInteger(declared) || declared < 0 || declared > maxBytes) {
      throw new RequestBodyTooLargeError(label, maxBytes);
    }
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestBodyTooLargeError(label, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

// Default ceiling for the dashboard's JSON mutators, matching MAX_OTLP_BODY_BYTES.
// Every one of them carries a handful of short scalar fields, so 1 MiB is orders
// of magnitude above any legitimate payload while still bounding the buffer.
export const MAX_JSON_BODY_BYTES = 1_048_576;

/**
 * `request.json()` with the byte ceiling applied during the read. Throws
 * RequestBodyTooLargeError when over the cap and SyntaxError on malformed
 * JSON, so callers' existing parse-error handling keeps working unchanged.
 */
export async function readBoundedJsonBody(
  request: Request,
  options: { maxBytes?: number; label: string }
): Promise<unknown> {
  const bytes = await readBoundedRequestBody(request, {
    maxBytes: options.maxBytes ?? MAX_JSON_BODY_BYTES,
    label: options.label,
  });
  return JSON.parse(new TextDecoder().decode(bytes));
}
