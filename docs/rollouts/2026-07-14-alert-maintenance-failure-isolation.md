# Alert-maintenance failure isolation

> Post-merge correction: the model/code-only classifier below was still broader than the safe operation boundary. PR #204 merged as `56d532ec` before root re-review completed. The isolated `codex/alert-persistence-config-generation` follow-up now narrows the boundary and adds incident/evidence/operation fencing, provider alert-config generations, cross-direction trigger/resolve invalidation, parent/child CAS, conservative PagerDuty migration, channel-specific ambiguity, and scheduler degradation propagation. See `docs/rollouts/2026-07-14-alert-persistence-corrective.md`.

## Incident evidence

On exact production revision `2d50264`, the immediate scheduler cycle reached
provider alert maintenance after its provider and money-path work had already
committed. A `ProviderAlertNotification.update` then timed out with Prisma
`P1008`, causing `runUsageMaintenance` to reject and the scheduler to mark the
whole cycle failed.

## Change

- Only Prisma `P1008` from the `ProviderAlertNotification` bookkeeping model is
  deferred. It is logged once and returned as `alerts.deferredError`. Schema,
  programming, and channel-state persistence failures remain fatal and visible
  to scheduler readiness.
- The same cycle does not retry the notification summary write. Successful
  channel sends persist their `ProviderAlertChannelDelivery.lastSucceededAt`
  first, so the next scheduled cycle suppresses a duplicate. The catch is not
  applied to channel-state failures, where non-PagerDuty delivery is at-least-once.
- Subscription materialization, provider-renewal roll-forward, and retention
  failures remain fatal because they affect cost and lifecycle correctness.
- No admission token is held across external alert-delivery network calls.

## Verification

Tests cover the deferred result, single log/no same-cycle retry, next-cycle
recovery, concurrent-call coalescing, in-flight cleanup, all fatal money-path
stages, and non-deferrable alert failures. Alert-delivery fault injection also
proves a successful channel outcome is durable before the notification-summary
P1008 and prevents a duplicate send on the next pass.
