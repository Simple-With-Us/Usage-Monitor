# Retain Unproven Native Overlap

Native aggregate telemetry and transcript calls stay additive.  A native input metric near a transcript cache-read event does not prove that the cache read was recorded, and one host's feed cannot prove another host's calls were recorded.

The former five-minute coverage rule is inert and performs no database reads.  It returns the original batch and reports zero covered duplicates.  Exact event idempotency and retention tombstones continue to prevent replay; the separately authenticated BotFleet exact-call path remains default-off.

Historical cache-read backfill must run after this receiver revision is live.  Aggregate native/transcript overlap may increase displayed token totals, which follows the owner's explicit preference for duplicate observations over lost calls.  A future native suppression path requires independent exact-call and token-component evidence; exporter health or timestamp proximity cannot enable it.
