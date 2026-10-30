import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildReceiptEvents,
  parseArgs,
  readPrivateReceiptInput,
  receiptSecretsForTarget,
  validatedBaseUrl,
} from "../../../scripts/import-private-billing-receipts.mjs";
import {
  stripReceiptTransportSignature,
  verifyReceiptCashEvent,
} from "../receipt-cash";

const NOW = new Date("2026-07-15T12:00:00.000Z");
const IDENTITY_KEY = "fixture-stable-identity-key-long-enough";
const SIGNING_KEY_A = "fixture-signing-key-alpha-long-enough";
const SIGNING_KEY_B = "fixture-signing-key-bravo-long-enough";
const tempPaths = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map((item) => fs.rm(item, { force: true, recursive: true }))
  );
});

describe("private billing receipt importer", () => {
  it("produces stable HMAC identifiers and a server-verifiable signature", () => {
    const providerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const receipts = [
      {
        receiptId: "fixture-receipt-alpha",
        amountUsd: 47.25,
        currency: "USD",
        kind: "api_prepaid_funding",
        occurredAt: "2026-07-01T00:00:00.000Z",
      },
    ];
    const first = buildReceiptEvents({
      receipts,
      providerId,
      providerName: "anthropic",
      identityKey: IDENTITY_KEY,
      signingKey: SIGNING_KEY_A,
      now: NOW,
    });
    const rotatedSigner = buildReceiptEvents({
      receipts,
      providerId,
      providerName: "anthropic",
      identityKey: IDENTITY_KEY,
      signingKey: SIGNING_KEY_B,
      now: NOW,
    });
    const rotatedIdentity = buildReceiptEvents({
      receipts,
      providerId,
      providerName: "anthropic",
      identityKey: "fixture-different-identity-key-long-enough",
      signingKey: SIGNING_KEY_A,
      now: NOW,
    });
    const changedAmount = buildReceiptEvents({
      receipts: [{ ...receipts[0], amountUsd: 52.5 }],
      providerId,
      providerName: "anthropic",
      identityKey: IDENTITY_KEY,
      signingKey: SIGNING_KEY_A,
      now: NOW,
    });

    expect(first[0]).toMatchObject({
      sourceApp: "billing-receipt-import",
      service: "api-prepaid-funding",
      label: "receipt_cash_paid",
      billingMode: "actual",
      metricType: "cost",
      unit: "usd",
      confidence: "actual",
      costUsd: 47.25,
    });
    expect(first[0].idempotencyKey).toBe(rotatedSigner[0].idempotencyKey);
    expect(first[0].keyRef).toBe(rotatedSigner[0].keyRef);
    expect(first[0].idempotencyKey).not.toBe(rotatedIdentity[0].idempotencyKey);
    expect(first[0].metadata.receiptSignature).not.toBe(
      rotatedSigner[0].metadata.receiptSignature
    );
    expect(stripReceiptTransportSignature(first[0].metadata)).toEqual(
      stripReceiptTransportSignature(rotatedSigner[0].metadata)
    );
    expect(first[0].idempotencyKey).toBe(changedAmount[0].idempotencyKey);
    expect(first[0].keyRef).toMatch(
      new RegExp(`^provider:${providerId}:billing-receipt:[0-9a-f]{64}$`)
    );
    expect(JSON.stringify(first)).not.toContain("fixture-receipt-alpha");
    expect(verifyReceiptCashEvent(first[0], SIGNING_KEY_A, NOW)).toBe(true);
    expect(verifyReceiptCashEvent(first[0], SIGNING_KEY_B, NOW)).toBe(false);
    expect(verifyReceiptCashEvent(rotatedSigner[0], SIGNING_KEY_B, NOW)).toBe(true);
    expect(
      verifyReceiptCashEvent({ ...first[0], costUsd: 99 }, SIGNING_KEY_A, NOW)
    ).toBe(false);
  });

  it("requires one bounded, regular chmod-600 file descriptor", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "receipt-import-"));
    tempPaths.push(directory);
    const inputPath = path.join(directory, "receipts.json");
    await fs.writeFile(
      inputPath,
      JSON.stringify({ receipts: [{ receiptId: "fixture-id", amountUsd: 1 }] }),
      { mode: 0o644 }
    );
    await fs.chmod(inputPath, 0o644);
    await expect(readPrivateReceiptInput(inputPath)).rejects.toThrow(/mode 600/);
    await fs.chmod(inputPath, 0o600);
    await expect(readPrivateReceiptInput(inputPath)).resolves.toHaveLength(1);

    const symlinkPath = path.join(directory, "receipts-link.json");
    await fs.symlink(inputPath, symlinkPath);
    await expect(readPrivateReceiptInput(symlinkPath)).rejects.toThrow(/regular file|symlink/);

    const oversizedPath = path.join(directory, "oversized.json");
    await fs.writeFile(oversizedPath, Buffer.alloc(1024 * 1024 + 1), { mode: 0o600 });
    await expect(readPrivateReceiptInput(oversizedPath)).rejects.toThrow(/larger than 1 MiB/);
  });

  it("rejects receipts beyond the bounded future clock skew", () => {
    expect(() =>
      buildReceiptEvents({
        receipts: [
          {
            receiptId: "fixture-future-receipt",
            amountUsd: 47.25,
            kind: "api_prepaid_funding",
            occurredAt: "2026-07-15T12:06:00.000Z",
          },
        ],
        providerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        providerName: "anthropic",
        identityKey: IDENTITY_KEY,
        signingKey: SIGNING_KEY_A,
        now: NOW,
      })
    ).toThrow(/too far in the future/);
  });

  it("allows only the production origin or explicit localhost", () => {
    expect(validatedBaseUrl("https://usage.jays.services").href).toBe(
      "https://usage.jays.services/api/ingest/usage"
    );
    expect(() =>
      validatedBaseUrl("https://usage.jays.services.attacker.example")
    ).toThrow(/must be https:\/\/usage\.jays\.services/);
    expect(() => validatedBaseUrl("http://localhost:4103")).toThrow(
      /--allow-localhost/
    );
    expect(
      validatedBaseUrl("http://localhost:4103", { allowLocalhost: true }).href
    ).toBe("http://localhost:4103/api/ingest/usage");
  });

  it("never falls back to production receipt credentials for localhost", () => {
    expect(
      receiptSecretsForTarget(new URL("http://localhost:4103"), {
        BILLING_RECEIPT_INGEST_TOKEN: "production-token",
        BILLING_RECEIPT_IDENTITY_KEY: "production-identity-key",
        BILLING_RECEIPT_HMAC_KEY: "production-signing-key",
      })
    ).toEqual({
      identityKey: undefined,
      signingKey: undefined,
      token: undefined,
      localTarget: true,
    });
    expect(
      receiptSecretsForTarget(new URL("http://127.0.0.1:4103"), {
        BILLING_RECEIPT_INGEST_TOKEN: "production-token",
        BILLING_RECEIPT_IDENTITY_KEY: "production-identity-key",
        BILLING_RECEIPT_HMAC_KEY: "production-signing-key",
        BILLING_RECEIPT_LOCAL_INGEST_TOKEN: "local-token",
        BILLING_RECEIPT_LOCAL_IDENTITY_KEY: "local-identity-key",
        BILLING_RECEIPT_LOCAL_HMAC_KEY: "local-signing-key",
      })
    ).toEqual({
      identityKey: "local-identity-key",
      signingKey: "local-signing-key",
      token: "local-token",
      localTarget: true,
    });
  });

  it("defaults to dry-run and gates apply on backup acknowledgement", () => {
    const common = [
      "--input",
      "/secure/input.json",
      "--provider-id",
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "--provider-name",
      "anthropic",
    ];
    expect(parseArgs(common)).toMatchObject({ apply: false });
    expect(() => parseArgs([...common, "--apply", "--base-url", "https://example.com"]))
      .toThrow(/backup-acknowledged/);
  });
});
