import { describe, expect, it } from "vitest";
import {
  RequestBodyTooLargeError,
  readBoundedRequestBody,
} from "@/lib/bounded-request-body";

const LABEL = "Test payload";

function requestWithBody(body: BodyInit | null, headers: Record<string, string> = {}) {
  return new Request("https://example.test/ingest", {
    method: "POST",
    headers,
    body,
    // Required by undici/fetch when streaming a ReadableStream body.
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  } as RequestInit);
}

describe("readBoundedRequestBody", () => {
  it("rejects a non-positive or non-integer maxBytes", async () => {
    const request = requestWithBody("{}");
    await expect(
      readBoundedRequestBody(request, { maxBytes: 0, label: LABEL })
    ).rejects.toThrow("Request body limit must be a positive safe integer");
    await expect(
      readBoundedRequestBody(request, { maxBytes: -1, label: LABEL })
    ).rejects.toThrow("Request body limit must be a positive safe integer");
    await expect(
      readBoundedRequestBody(request, { maxBytes: 1.5, label: LABEL })
    ).rejects.toThrow("Request body limit must be a positive safe integer");
  });

  it("rejects a declared Content-Length above the cap before reading the body", async () => {
    const request = requestWithBody("{}", { "content-length": "1000" });
    await expect(
      readBoundedRequestBody(request, { maxBytes: 10, label: LABEL })
    ).rejects.toThrow(RequestBodyTooLargeError);
  });

  it("rejects a chunked stream that exceeds the cap even without Content-Length", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8));
        controller.enqueue(new Uint8Array(8));
        controller.close();
      },
    });
    const request = requestWithBody(stream);

    let error: unknown;
    try {
      await readBoundedRequestBody(request, { maxBytes: 10, label: LABEL });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RequestBodyTooLargeError);
    expect((error as RequestBodyTooLargeError).message).toBe(
      `${LABEL} exceeds 10 bytes`
    );
    expect((error as RequestBodyTooLargeError).maxBytes).toBe(10);
  });

  it("returns the full body when it is within the cap", async () => {
    const payload = JSON.stringify({ ok: true });
    const request = requestWithBody(payload);
    const bytes = await readBoundedRequestBody(request, {
      maxBytes: 1024,
      label: LABEL,
    });
    expect(new TextDecoder().decode(bytes)).toBe(payload);
  });

  it("returns an empty buffer for a bodyless request", async () => {
    const request = new Request("https://example.test/ingest", { method: "GET" });
    const bytes = await readBoundedRequestBody(request, {
      maxBytes: 1024,
      label: LABEL,
    });
    expect(bytes.byteLength).toBe(0);
  });
});
