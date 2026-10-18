# Usage Monitor public API contract

Machine-checkable reference for the four public endpoints. The v2 ingest wire
schema, canonical idempotency, and ACK semantics are owned byte-for-byte by
`@jaywedgeworth22/congress-trading-shared` (currently pinned at `v2.5.2` in
`package.json`); this document describes the receiver side only. Do not loosen
the v2 schema or change idempotency semantics here.

Base URL (production): `https://usage.jays.services`

## Conventions

- **Typed v2 error body** (ingest endpoints, when the request is v2 — see
  version marker below). Error codes are the shared enum:
  `invalid_request | unauthorized | forbidden | rate_limited | receiver_busy |
  idempotency_conflict | payload_too_large | not_configured | internal_error`.

  ```json
  {
    "ok": false,
    "schemaVersion": 2,
    "error": {
      "code": "receiver_busy",
      "message": "Usage ingest is busy. Retry later.",
      "retryable": true,
      "retryAfterSeconds": 5
    }
  }
  ```

  `retryAfterSeconds` mirrors the `Retry-After` response header (seconds).
  Producers must persist an outbox and retry after the signaled backoff;
  retries are deduped by the canonical idempotency key.
- **Unexpected failures** are always JSON — `{ "error": "..." }` for v1/plain
  clients, the typed body above (code `internal_error`, `retryable: true`) for
  v2 clients and `POST /api/otlp/v1/metrics`. The receiver never intentionally
  returns an untyped HTML 500.
- **Rate limiting** is per authenticated credential (a hash of the presented
  token), 10 rps, checked after authentication; unauthenticated traffic is
  throttled separately by a topology-aware IP backstop. Per-producer isolation
  requires per-producer tokens (`USAGE_INGEST_PRODUCER_TOKENS`).

## `POST /api/ingest/usage`

Writes `ExternalUsageEvent` rows (ordinary usage telemetry and, for the
dedicated receipt credential, signed billing-receipt cash events).

**Auth** (either form, ordinary events):

```
Authorization: Bearer <USAGE_INGEST_TOKEN>
# or
x-usage-ingest-token: <USAGE_INGEST_TOKEN>
```

Billing-receipt cash events use the distinct `BILLING_RECEIPT_INGEST_TOKEN`
(same two header forms, header name `x-billing-receipt-ingest-token`).

**Version marker (v2):** send header `x-usage-telemetry-version: 2`, or simply
include `"schemaVersion": 2` in the body — the body marker alone is
sufficient. Unmarked bodies are parsed as legacy v1.

**Request (v2):** strict `UsageTelemetryV2BatchSchema` envelope; events are
validated per event, so one poison event no longer fails the batch.

```json
{
  "schemaVersion": 2,
  "producerId": "socratic-trade",
  "producerInstanceId": "prod-a",
  "events": [
    {
      "eventId": "ledger-event-1",
      "provider": "openai",
      "producerKeyRef": "configured-openai-primary",
      "metricType": "cost",
      "costUsd": 0.0231,
      "occurredAt": "2026-07-21T00:00:00.000Z"
    }
  ]
}
```

**Canonical AI usage (`ai` block, shared `v2.8.0`+, UM-1592):** an AI event may
carry one optional, strict `ai` object:  `model.{requested,served}`, `harness`,
`seat`, `tokens.{input,output,cacheRead,cacheWrite5m,cacheWrite1h,reasoning}`,
`durationMs`, `ttftMs`, `billingMode` (`subscription`/`payg`/`free`) and
`costSource` (`billed`/`estimated`).  `input` is uncached input only, `output`
includes reasoning, and `reasoning` is an informational subset of `output`.
Send `ai.tokens` on exactly one event per request.  Field semantics, SDK
mappings and the per-producer migration live in the shared package's
`docs/ai-usage-schema.md`.

The monitor persists the block into metadata under reserved keys a producer
cannot set:  `_aiModelRequested`, `_aiModelServed`, `_aiHarness`, `_aiSeat`,
`_aiTokensInput`, `_aiTokensOutput`, `_aiTokensCacheRead`,
`_aiTokensCacheWrite5m`, `_aiTokensCacheWrite1h`, `_aiTokensReasoning`,
`_aiDurationMs`, `_aiTtftMs`, `_aiBillingMode`, `_aiCostSource` and `_aiSource`
(`block` or `legacy`).  Events without the block are mapped onto the same keys
from the pre-UM-1592 metadata (`promptTokens`, `completionTokens`,
`cachedTokens`, `cacheWriteTokens`, `cacheWriteOneHourTokens`, `inputTokens`,
`outputTokens`, `cachedInputTokens`, and `tokenType` / `label: token:<type>`
slices), so every producer aggregates the same way.  Ingest cost derivation
prices the canonical tokens, 1-hour cache writes included.

**Response `202` (v2 ACK):** counts satisfy
`persisted + duplicates + pruned + rejected === received`.

```json
{
  "ok": true,
  "schemaVersion": 2,
  "received": 3,
  "persisted": 2,
  "duplicates": 0,
  "pruned": 0,
  "rejected": 1,
  "rejections": [
    { "index": 1, "eventId": "bad-event", "issues": ["provider: Required"] }
  ]
}
```

- `received` — every submitted event (valid + rejected).
- `persisted` — rows newly inserted by this call (idempotent replays add 0).
- `duplicates` — valid replays of already-active idempotency keys.
- `pruned` — blocked by retention tombstones.
- `rejected` — events that failed per-event schema validation.
- `rejections` — present only when `rejected > 0`; bounded to the first 10
  entries (`rejected` is always the exact total).

**Response `202` (legacy v1 ACK):**

```json
{
  "ok": true,
  "accepted": 1,
  "received": 2,
  "duplicates": 1,
  "ignoredPruned": 0
}
```

`accepted` is newly inserted rows; `received`/`duplicates` make full replays
visible (additive fields; older receivers omit them).

**Negative subscription adjustments (v1 only):** a negative `costUsd` is
accepted solely for `metricType: "subscription"` (owner-directed manual
corrections/refunds; the v2 schema rejects all negatives). Three inclusive
bounds apply — exceeding any of them rejects the WHOLE batch with `400
invalid_request`:

| Bound | Limit | Scope |
| --- | --- | --- |
| Per event | `$1,000` magnitude | one event's `costUsd` |
| Per batch | `$2,000` summed magnitude | all negative subscription events in one request |
| Trailing 30 days | `$5,000` summed magnitude | already-persisted negative subscription events (by server receipt time, not producer-supplied `occurredAt`) plus the incoming batch's new ones |

"Inclusive" means landing exactly on a limit is accepted. Positive amounts
and other metricTypes never count toward any bound. Idempotent replays do
not double-count against the 30-day window (replayed events insert no new
rows). On a window rejection, submit smaller corrections or wait for older
adjustments to age out of the trailing window. Constants:
`MAX_NEGATIVE_SUBSCRIPTION_COST_USD` /
`MAX_NEGATIVE_SUBSCRIPTION_BATCH_COST_USD` (`src/lib/usage-telemetry.ts`)
and `MAX_NEGATIVE_SUBSCRIPTION_WINDOW_COST_USD` /
`NEGATIVE_SUBSCRIPTION_WINDOW_DAYS` (`src/lib/external-usage-events.ts`).

**Notable statuses:** `400 invalid_request` (malformed body, invalid v2
envelope, or a negative-subscription-adjustment bound exceeded — see above),
`401 unauthorized`, `409 idempotency_conflict`, `413
payload_too_large` (body > 4 MiB), `429 rate_limited` (`Retry-After: 30`),
`503 receiver_busy` (`Retry-After: 5` — single-writer admission; retry the
batch), `503 not_configured`.

## `POST /api/otlp/v1/metrics`

Standard OTLP-HTTP metrics receiver (Claude Code or any OTLP exporter).

**Auth:** identical to `POST /api/ingest/usage` (`USAGE_INGEST_TOKEN`).

**Content-Type:** `application/json` (or omitted) or `application/x-protobuf`.
gRPC is not supported — a gRPC-configured client gets `415` with a message
naming `OTEL_EXPORTER_OTLP_PROTOCOL=http/json` / `http/protobuf`.

**Response `202`:**

```json
{
  "ok": true,
  "accepted": 1,
  "ignoredPruned": 0,
  "ignoredOutOfOrder": 0,
  "idempotentRetries": 0,
  "unknownMetrics": [
    { "name": "claude_code.brand_new_metric.count", "dataPointCount": 1 }
  ]
}
```

Optional counts are omitted when zero. Unknown metric names are accepted,
tallied, and never mapped or 500'd. Retries are idempotent via content-hash
keys. Failure modes mirror the ingest route; unexpected failures return the
typed `internal_error` body with `Retry-After: 30`.
`OTLP_METRICS_INGEST_ENABLED=false` fails closed with authenticated `503` +
`Retry-After: 300` before body decoding.

## `GET /api/budget-status`

Per-provider and per-project month-to-date spend vs configured budgets.

**Auth (either):** dashboard session cookie, or a read token as

```
Authorization: Bearer <USAGE_READ_TOKEN>
# or
x-usage-read-token: <USAGE_READ_TOKEN>
# legacy header-name alias, still accepted:
x-usage-ingest-token: <USAGE_READ_TOKEN>
```

In production `USAGE_READ_TOKEN` is required (no silent ingest-token fallback);
outside production it falls back to `USAGE_INGEST_TOKEN`. Without a session
cookie and no resolvable read token the endpoint is `503`; a wrong token is
`401`.

**Versioning:** responses carry `x-api-version: 1`. Additive changes keep the
version; a breaking change bumps it.

**Response `200` (shape, abbreviated):**

```json
{
  "generatedAt": "2026-07-29T12:00:00.000Z",
  "providers": [
    {
      "provider": "openai",
      "monthToDateUsd": 12.34,
      "monthlyBudgetUsd": 50,
      "breachState": "ok"
    }
  ],
  "projects": [],
  "summary": {}
}
```

Also sends `cache-control: no-store`, `x-budget-generated-at`, and `age`
(snapshot age in seconds) so throttled consumers can back off without parsing
the body.

## `GET /api/subscriptions`

Lists subscriptions with provider/project labels, monthly-equivalent cost,
status, and effective `knobEnv` vs the provider free tier.

**Auth:** identical to `GET /api/budget-status` (dashboard session cookie OR
the read token, same three header forms). `POST /api/subscriptions` and the
`/:id` sub-routes remain dashboard-session-only and are not part of this
public contract.

**Versioning:** `x-api-version: 1` response header.

**Response `200` (one row, abbreviated):**

```json
[
  {
    "id": "sub_...",
    "name": "Tiingo Pro",
    "costUsd": 30,
    "currency": "USD",
    "interval": "monthly",
    "monthlyEquivalentUsd": 30,
    "status": "active",
    "effectiveStatus": "active",
    "nextRenewalAt": "2026-08-01T00:00:00.000Z",
    "knobEnv": { "PROVIDER_QUOTA_TIINGO_PER_HOUR": "500" },
    "freeTierKnobEnv": { "PROVIDER_QUOTA_TIINGO_PER_HOUR": "50" },
    "provider": { "id": "...", "name": "tiingo", "displayName": "Tiingo" },
    "project": null
  }
]
```

## Boundary: `GET /api/usage-events` is not public

`GET /api/usage-events` (summary mode and `?raw=1` per-event mode) is
**dashboard-session-only by design**. It is deliberately absent from the
middleware's public-path list, so every request without a valid dashboard
session cookie gets a `401` from the middleware before the route runs — the
`USAGE_READ_TOKEN` accepted by `/api/budget-status` and `/api/subscriptions`
does **not** work here, in any header form.

Rationale: `budget-status` (aggregates) and the daily-rollups export are the
intended external read paths. Raw per-event telemetry (idempotency keys,
per-request cost rows, verification status) stays behind the interactive
dashboard session.

Operational consequence, stated so nobody rediscovers it mid-incident:
**headless debugging goes through a session cookie or does not happen.**
Obtain a session via the dashboard login and replay its cookie; do not add a
bearer/token surface to this route, and do not add it to the middleware
public-path list. Anyone who believes this boundary should change must change
this contract first, not the code.
