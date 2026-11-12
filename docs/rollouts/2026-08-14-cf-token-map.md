# 2026-08-14 — `cf-token-map.sh`

Monet started a probe (chat “Version availability question”) so agents can
see which Infisical Cloudflare token names reach which CF accounts, then
hit the weekly usage cap mid-script.

`bash scripts/cf-token-map.sh` (after loading `~/.secrets/global-api-keys`)
finishes that work.  Token values never print.  Output is name, length, an
8-hex SHA-256 fingerprint, and `GET /accounts`.

## Live snapshot (UM Infisical prod, 2026-08-14)

| Infisical name | fp | Sees |
|---|---|---|
| `CLOUDFLARE_FLEET_API_TOKEN` | `f5bd444a` | all four accounts |
| `CLOUDFLARE_CT_API_TOKEN` | `f5bd444a` | same token as fleet |
| `CLOUDFLARE_API_TOKEN` | `f5bd444a` | same token as fleet |
| `R2_USAGE_API_TOKEN` | `f5bd444a` | same token as fleet |
| `CLOUDFLARE_JAY_API_TOKEN` | `d968dc70` | all four (different token) |
| `CLOUDFLARE_ST_API_TOKEN` | `100c3da8` | SocraticTrade.com only |
| `CLOUDFLARE_OLD_API_TOKEN` | — | absent |

Account ids: Usage.Jays.Services `3a9368057468d0909cafaa85df12d1b7`,
SocraticTrade.com `94ec35cf8b40d3bf9710c0e3320b2e79`,
Congress.Trade `0e9f5a0c02a90fba7bf506f819b31ae9`,
jay (Old) `254301ba6b6323381932ddbca9608c73`.

Use fleet (or the JAY token) for multi-account work.  Use `CLOUDFLARE_ST_API_TOKEN`
only when you must stay inside the Socratic account.  Re-run the script after
any Infisical token rotation; fingerprints change when the bytes change.
