# OpenRouter observability

OpenRouter Broadcast should have two independent destinations.  Sentry receives searchable traces; Usage Monitor receives diagnostic per-request rows.  The existing OpenRouter adapter remains the cash and credit authority.

## Sentry destination

Use the Sentry project dedicated to agent sessions.  Do not use the Usage Monitor application project or the fleet-infrastructure aggregate project for OpenRouter request traces.

In Sentry, open **Settings → Projects → agent-sessions → SDK Setup → Client Keys (DSN) → OpenTelemetry**.  Copy the OTLP traces endpoint ending in `/integration/otlp/v1/traces` and the DSN from that page.

In OpenRouter, open **Settings → Observability**, enable Broadcast, and add a **Sentry** destination with those two values.  Enable Privacy Mode so prompts and completions are excluded while token counts, cost, timing, model, provider, and status remain available.  Begin with a reviewed API-key subset and a sampling rate sized to the destination budget; increase it only after receipt, field coverage, and rate-limit headroom are measured.

Enter these values directly in OpenRouter.  Do not paste the DSN, OTLP endpoint, OpenRouter management key, or Usage Monitor bearer token into chat, tickets, commits, or logs.

## Usage Monitor destination

Add a second OpenRouter Broadcast destination of type **OpenTelemetry Collector**:

- Endpoint: `<Usage Monitor OTLP traces endpoint from the private operations inventory>`
- Headers: `Authorization: Bearer <trace-only token for openrouter>`
- Privacy Mode: enabled
- Sampling: sized to remain below the receiver's per-token request budget
- API-key filter: an explicit reviewed subset during verification

Configure the token as `openrouter:<token>` in `OTLP_TRACES_PRODUCER_TOKENS`.  Never register it in `USAGE_INGEST_PRODUCER_TOKENS`: that map also authorizes cash-ledger and metrics writes.  Use the existing secret-management and deployment path, then restart the Usage Monitor container because the token maps are loaded at process startup; never commit the token.

The trace receiver admits at most 10 requests per second for one credential.  Before widening the API-key filter or increasing sampling, measure Broadcast request rate and either keep it within that budget, raise the reviewed receiver budget, or issue additional trace-only tokens with independent rate buckets.

This trace route writes `AgentTurn` only.  It does not write `ExternalUsageEvent`, so it cannot double-count the OpenRouter account spend and credits collected by `src/lib/adapters/openrouter.ts`.  OpenRouter spans carry the underlying model vendor in `gen_ai.system`; the receiver recognizes `openrouter.trace.id` and records the platform as `openrouter` unless the producer supplies an explicit `agent.platform`.

## Verification

After OpenRouter's connection test passes, send one harmless inference through a selected coding key and verify all three receipts:

1. The Sentry `agent-sessions` project shows one trace with no prompt or completion content.
2. Usage Monitor shows one `AgentTurn` with platform `openrouter`, model, input/output tokens, duration, cost, and generation ID when supplied.
3. The OpenRouter account adapter continues to report cash and credits once, with no new `ExternalUsageEvent` created by the trace receipt.

Record the test time in America/Chicago and the selected OpenRouter key hash or label only.  Never record the key value, DSN secret, bearer token, prompt, or completion.

## Fleet-wide role

OpenRouter Broadcast covers calls that actually traverse OpenRouter, regardless of whether they originate on the Mac, server, or cloud.  It does not prove that every coding platform uses OpenRouter, and it cannot recover local tool activity or subscription quota windows.  Keep native/local collectors and the telemetry hub for those independent signals, with one authoritative Usage Monitor ledger path per platform.
