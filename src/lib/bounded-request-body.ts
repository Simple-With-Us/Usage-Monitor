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
