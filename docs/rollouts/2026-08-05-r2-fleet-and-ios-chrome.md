# R2 fleet metrics + iOS chrome polish (2026-08-05)

## R2 free tier (hosted Usage Monitor)

Live GraphQL check of the three independent Cloudflare free tiers:

| Account | Storage MTD | Class A | Class B |
|---------|-------------|---------|---------|
| Usage Monitor (`3a936805…`) | ~7.9 GiB / 10 (79%) | ~75k / 1M | ~3k / 10M |
| Socratic Trade (`94ec35cf…`) | ~5.2 GiB / 10 (52%) | ~159k / 1M | ~384k / 10M |
| Congress Trade (`0e9f5a0c…`) | ~8.4 GiB / 10 (84%) | ~390k / 1M | ~49k / 10M |

CT and UM storage are **above the 70% absolute storage threshold** (ops still under).

### App changes

- Ops / dashboard **R2 free tier (fleet)** card shows all three accounts with the same three metrics and status fields used in Pushover digests: storage / Class A / Class B with MTD (+ pace for ops), threshold, source, Litestream→R2, top buckets, status line.
- Infisical `usage-monitor` prod: added `CLOUDFLARE_ST_ACCOUNT_ID`, `CLOUDFLARE_ST_API_TOKEN`, `CLOUDFLARE_CT_ACCOUNT_ID`, `CLOUDFLARE_CT_API_TOKEN` so fleet slots configure.

## iOS (hosted remote app, not Local)

- Tab roots use `.navigationBarTitleDisplayMode(.inline)` so titles stay centered/compact (no large left title at rest).
- Projects list no longer repeats a large in-content "Projects" header.
- Guard empty SF Symbol names (`No symbol named '' found`).
