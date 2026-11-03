# Unmeasured Collector Calls

Known collector calls without a measured duration are metadata logs with operation `chat`.  Calls with a measured duration, including a legitimate zero, remain spans.  Token observations without a call identity keep their existing log shape.  This prevents the hub from interpreting a missing duration as a measured zero.

Collector event IDs and source token events do not change.  Legacy pending spans with unknown timing are classified as logs only during delivery; their durable payloads and IDs remain intact.  Sent receipts suppress replay, and pending or quarantined records remain retained.  The hub derives different identities for spans and logs, so an earlier ambiguous delivery whose acknowledgment was lost can leave both an old span and a new log.  This change does not delete historical spans or claim receiver deduplication across signal types.
