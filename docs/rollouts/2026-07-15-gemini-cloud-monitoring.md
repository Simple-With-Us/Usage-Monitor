# Gemini Cloud Monitoring usage and quota enrichment

## Outcome

The Google AI adapter can now use its existing encrypted Google service-account
credential plus the exact Gemini project ID to read project-level Gemini API
request and quota metadata from Cloud Monitoring. This is independent from both
the API-key control-plane check and the Cloud Billing BigQuery export:

- API-key validation still lists models without inference.
- Cloud Monitoring supplies request counts and request/token quota metadata.
- The standard BigQuery export remains the only direct cash-cost source.
- A Monitoring failure cannot replace, clear, or fabricate BigQuery cash cost.

Each successful or failed Monitoring check is bound server-side to a SHA-256
fingerprint of the exact project ID and service-account JSON used for that
check. The fingerprint stays in encrypted/internal snapshot data and is never
returned by provider APIs or UI. Rotating either input makes the prior result
`configuration_changed` with no check timestamp until the new identity is
actually verified; legacy snapshots without a fingerprint are conservatively
`unchecked`.

## Required Google access

Grant the configured service account `roles/monitoring.viewer` on the exact
Gemini project and set `googleProjectId` to that project ID. The OAuth assertion
for this channel requests only:

`https://www.googleapis.com/auth/monitoring.read`

No IAM policy or secret is created or changed by this app. The billing channel
continues to request its separate BigQuery read-only scope only when a billing
export dataset is configured.

## Official metrics queried

Every time-series filter has an exact `project = "<googleProjectId>"`
selector. The primary quota path discovers active metric descriptors under:

- `generativelanguage.googleapis.com/quota/.../usage`
- `generativelanguage.googleapis.com/quota/.../limit`

These current Gemini-native metrics use the
`generativelanguage.googleapis.com/Location` monitored resource and preserve
model, tier, and location. `DELTA` descriptors are summed month-to-date.
`GAUGE` descriptors query only the latest 15-minute window (well beyond the
documented 60-second sample period plus 150-second visibility delay) and use
the newest point, avoiding more than 5,000 raw points per dimension later in a
month. An empty recent GAUGE window is partial/unknown and preserves prior
metadata. Descriptor discovery and per-metric queries are bounded, and a
failed metric cannot clear successful siblings. The documented legacy-named
`generate_requests_per_model` quota is explicitly classified as paid tier even
though its metric path omits `paid_tier`.

Unsafe GAUGE values and overflowing DELTA groups are isolated to the affected
native quota dimension. The incomplete group is discarded (rather than
under-reported), the channel becomes partial with an `INVALID_RESPONSE`, and
valid aggregate requests plus valid sibling quota dimensions remain available.

`serviceruntime.googleapis.com/api/request_count` remains only as a clearly
labelled aggregate request fallback. It is additionally restricted to
`resource.labels.service = "generativelanguage.googleapis.com"`. Method and
credential identifiers returned in labels are discarded.

Google currently documents up to 150 seconds of visibility delay for native
Gemini quota usage and limit metrics and up to 1,800 seconds for aggregate
request counts. Consequently, successful empty results remain unknown (`null`),
never false zero. An empty aggregate request fallback is non-authoritative and
preserves the previous month-to-date row through visibility latency; only an
observed aggregate point is authoritative/current. Native discovery is
intentionally recent-series-only, so native sources remain non-authoritative:
absent, failed, or bounded dimensions preserve prior records instead of
implying deletion.

## Safety bounds

- 15-second HTTP timeout per Monitoring request
- 512 KiB response limit
- 1,000 points per time-series page
- five pages / 5,000 points per metric query
- two descriptor pages / 2,000 discovered descriptors
- at most 40 native quota metric queries, in batches of 10
- 100 retained request/token quota dimensions per usage or limit source
- repeated page tokens and out-of-scope/malformed series are rejected

Monitoring-derived records are metadata-only and cannot enter recurring or cash
cost rollups.

## References

- [Google Cloud metrics: Gemini API](https://cloud.google.com/monitoring/api/metrics_gcp_d_h)
- [Google Cloud metrics: Service Runtime](https://cloud.google.com/monitoring/api/metrics_gcp_p_z)
- [Google Cloud monitored resources](https://cloud.google.com/monitoring/api/resources)
- [Cloud Monitoring `projects.metricDescriptors.list`](https://cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.metricDescriptors/list)
- [Cloud Monitoring `projects.timeSeries.list`](https://cloud.google.com/monitoring/api/ref_v3/rest/v3/projects.timeSeries/list)
- [Cloud Monitoring filters and project selectors](https://cloud.google.com/monitoring/api/v3/filters)

## Verification

Focused adapter and UI tests cover OAuth scope, exact project/service filters,
request/token parsing, empty results, permission denial, partial-query survival,
credential/project rotation, server-only fingerprint redaction, unsafe GAUGE
isolation, grouped DELTA overflow isolation, bounded pagination, cash-cost
isolation, and token quota labels. Run the full repository gate with
`npm run verify` before landing.
