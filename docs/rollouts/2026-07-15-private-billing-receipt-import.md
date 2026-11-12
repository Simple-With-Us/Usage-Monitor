# Private billing-receipt import

This lane adds a provider-neutral importer for exact USD API prepaid-funding
receipts. It does not contain or import any real receipt/account evidence.

## Private input

Keep the JSON outside the repository and set mode `600`:

```json
{
  "receipts": [
    {
      "receiptId": "fixture-provider-receipt-id",
      "amountUsd": 20,
      "currency": "USD",
      "kind": "api_prepaid_funding",
      "occurredAt": "2026-07-01T00:00:00.000Z",
      "creditsPurchased": 20
    }
  ]
}
```

`receiptId` is used only as HMAC input. It is never sent to the app, stored in
SQLite, or printed. Stored identifiers contain only the provider UUID and the
HMAC digest.

## Dry-run and apply

Dry-run is the default and requires the stable `BILLING_RECEIPT_IDENTITY_KEY`
plus the rotatable `BILLING_RECEIPT_HMAC_KEY` signing key. The identity key
derives durable receipt IDs without revealing private IDs; rotating only the
signing key therefore never rekeys existing cash evidence:

```bash
npm run import:billing-receipts -- \
  --input /path/outside/repo/receipts.json \
  --provider-id 00000000-0000-4000-8000-000000000000 \
  --provider-name anthropic
```

Apply also requires an explicit backup acknowledgement plus the dedicated
`BILLING_RECEIPT_INGEST_TOKEN`, `BILLING_RECEIPT_IDENTITY_KEY`, and
`BILLING_RECEIPT_HMAC_KEY`; secrets are never
accepted as command-line flags and the receipt token must differ from the
ordinary usage-ingest token:

```bash
npm run import:billing-receipts -- \
  --input /path/outside/repo/receipts.json \
  --provider-id 00000000-0000-4000-8000-000000000000 \
  --provider-name anthropic \
  --apply --backup-acknowledged \
  --base-url https://usage.jays.services
```

The only remote origin allowed is exactly `https://usage.jays.services`. Local
testing requires `--allow-localhost` and the separate
`BILLING_RECEIPT_LOCAL_INGEST_TOKEN`, `BILLING_RECEIPT_LOCAL_IDENTITY_KEY`, and
`BILLING_RECEIPT_LOCAL_HMAC_KEY` values. These names are importer-only; the
server always reads the canonical receipt token and signing-key names regardless
of URL or forwarded peer. Launch the local server by explicitly mirroring only
the local client token/signing key into its canonical server variables:

```bash
BILLING_RECEIPT_INGEST_TOKEN="$BILLING_RECEIPT_LOCAL_INGEST_TOKEN" \
BILLING_RECEIPT_HMAC_KEY="$BILLING_RECEIPT_LOCAL_HMAC_KEY" \
npm run dev -- --turbopack
```

The identity key is never needed by the server. The importer still requires
`--allow-localhost`, and production receipt credentials are never selected for
that local client path.

Apply posts only redacted, HMAC-signed events to `POST /api/ingest/usage`. The
route admits them only with the dedicated token, verifies each signature, and
verifies every embedded provider UUID/name pair before persistence. Existing
idempotency collision and retention tombstone semantics therefore apply without
a direct Prisma bypass. `receiptSignature` is transport-only and is stripped
after verification, so signing-key rotation cannot change stored metadata or
turn an idempotent replay into a collision.

## Accounting semantics

- `receiptCashPaidUsd` is exact cash paid for API prepaid funding.
- `observedVariableUsageUsd` is the max of provider snapshot variable cost and
  pushed variable usage.
- Canonical variable cash is `max(receiptCashPaidUsd, observedVariableUsageUsd)`.
- Materialized subscription periods and other reconciled fixed charges remain
  additive.
- Claude Code API-equivalent estimates remain visible but excluded from cash.
- Receipt deposits are not extrapolated as consumption. While receipt cash is
  at least observed usage, the variable end-of-month projection stays at the
  receipt amount.

No historical event or subscription row is deleted or rewritten.
