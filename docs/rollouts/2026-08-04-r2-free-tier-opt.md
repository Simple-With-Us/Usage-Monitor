# 2026-08-04 — Usage-Monitor R2 free-tier opt [GROK]

usage-monitor-bucket was at **10.45 GiB (104% free tier)** with snapshot
retention 168h. Live DB is small; LTX history filled the bucket.

- snapshot retention **168h → 48h**
- replica **sync-interval: 60s** (was implicit 1s default)

App performance unaffected (backup path only). Redeploy so litestream GC
can reclaim objects older than 48h.
