# Infisical provider-credential sync

## Scope

The startup poll and each scheduled poll read an exact allowlist through three
independent Infisical Universal Auth identities. Values are never logged or put
in provider metadata. Provider API keys and secondary secret configuration are
stored with the app's existing AES-256-GCM envelopes; the encrypted envelope
also carries a non-secret scope/source binding for idempotent rotation. Secret
equality is checked directly only after decrypting inside the server process.

- `st` remains attributed to `SocraticTrade.com`.
- `ct` remains attributed to `Congress.Trade`.
- `shared` is used only for shared-only integrations or as an app-scoped
  fallback after a successful app-project read proves a value absent.
- Authentication/read failures retain the encrypted last-known-good value.
- Brokerage keys and providers whose adapters deliberately make no account,
  usage, quota, or billing request are excluded.

## Sanitized allowlist (names only)

| Scope | Infisical names | Monitor destination |
|---|---|---|
| SocraticTrade.com | `DEEPSEEK_API_KEY` | DeepSeek balance |
| SocraticTrade.com | `GEMINI_API_KEY` | Google AI key validation |
| SocraticTrade.com | `HETZNER_API_TOKEN` | Hetzner inventory/run-rate |
| SocraticTrade.com | `PINECONE_API_KEY` | Pinecone inventory |
| SocraticTrade.com | `RESEND_API_KEY` | Resend key/usage control plane |
| SocraticTrade.com | `SENTRY_AUTH_TOKEN`, `SENTRY_ORG` | Sentry usage |
| Congress.Trade | `OPENAI_API_KEY` | OpenAI key/usage path |
| Congress.Trade | `DEEPSEEK_API_KEY` | DeepSeek balance |
| Congress.Trade | `GEMINI_API_KEY` | Google AI key validation |
| Congress.Trade | `INTRINIO_API_KEY` | Intrinio quota |
| Congress.Trade | `LLAMAPARSE_API_KEY` | LlamaIndex Cloud usage |
| Congress.Trade | `MISTRAL_API_KEY` | Mistral account/limit path |
| Congress.Trade | `RESEND_API_KEY` | Resend key/usage control plane |
| Congress.Trade | `STRIPE_SECRET_KEY` | Stripe processing fees/balance |
| Congress.Trade | `TWELVEDATA_API_KEY` | Twelve Data plan/quota |
| Shared | `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, optional `LANGFUSE_BASE_URL` | Langfuse usage |
| Shared | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio balance/month-to-date usage |
| Shared fallback only | `RESEND_API_KEY`, `TWELVEDATA_API_KEY` | Missing ST/CT value only |

The live Socratic.Trade convention is project
`39d93bb7-76f9-498c-8b50-a7def52e072f`, environment `prod`, path `/`.
That exact scope currently has no `GEMINI_API_KEY`, `OPENAI_API_KEY`, or
`MISTRAL_API_KEY`. Its `GOOGLE_APPLICATION_CREDENTIALS` value is a non-JSON
path and therefore cannot be copied into the monitor's JSON billing credential
field. The sync is ready to bind an ST Google candidate while preserving the
separate CT candidate. To auto-manage the existing ST Gemini provider, add
`GEMINI_API_KEY` to the Socratic.Trade Infisical `prod` `/` scope; until then,
the manually valid ST provider remains unchanged.

## Runtime configuration

Render declares `INFISICAL_PROVIDER_SYNC_ENABLED=true` and six `sync: false`
bootstrap variables:

- `INFISICAL_ST_CLIENT_ID`, `INFISICAL_ST_CLIENT_SECRET`
- `INFISICAL_CT_CLIENT_ID`, `INFISICAL_CT_CLIENT_SECRET`
- `INFISICAL_SHARED_CLIENT_ID`, `INFISICAL_SHARED_CLIENT_SECRET`

Project IDs and `/` paths have verified defaults; environment defaults to
`prod`. Reads accept only official Infisical HTTPS hosts and reject redirects.
Each source must first pass the official unpaginated v4 list-scope check with
secret values, references, recursion, personal overrides, and imports disabled.
Only a successful list response with a `secrets` array makes a later per-key
404 a proven miss that may use a configured shared fallback; any authentication,
scope, schema, or key-read error retains the encrypted last-known-good value.
Response JSON is streamed through a 128 KiB cap and the transport is canceled as
soon as it exceeds that limit. Legacy-row adoption uses the static cross-scope
mapping multiplicity even when another scope is temporarily unavailable.
The network phase does not hold the process SQLite writer lease; only the short
database apply phase is serialized with other internal usage writes.
