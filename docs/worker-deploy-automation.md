# Mapped Worker deploy automation

Default off: set WORKER_DEPLOY_ENABLED=true only after credentials, exact-version
receipts, and functional probes are reviewed. No secrets are rotated by this
workflow. CLOUDFLARE_FLEET_API_TOKEN (Fleet-OPS/prod/root) is the existing scoped deploy credential;
Access-protected probes use WORKER_HEALTH_ACCESS_CLIENT_ID/SECRET. Receipt inbox
also needs its existing read token and lifecycle audit token. Do not widen access
or publish private receipt data to satisfy a probe.

The job tests current main, serializes deployments, rechecks main immediately
before mutation, tags the Worker version with the exact SHA, verifies 100%
production routing to that version, then runs the functional probe. Wrangler
uses --keep-vars and --strict. Existing schema, bindings and migrations remain
owned by each Worker's reviewed configuration. A half-hour drain catches merges
made with bot tokens. Already-live revisions still get a health check.

Incomplete targets deliberately excluded from the matrix: usage-monitor-receipt-lifecycle-auditor. Their private
or absent health routes need an approved probe before automation can be enabled.
No public health bypass is introduced. Ambiguous start-jays-services,
fleet-share-api and BotFleet broker are not included. No iOS workflow is changed.

CI reads the scoped Cloudflare token from Fleet-OPS/prod/root through the existing
automation identity. Repository bootstrap names: INFISICAL_AUTOMATION_CLIENT_ID
and INFISICAL_AUTOMATION_CLIENT_SECRET. Provisioning those CI bootstrap secrets
is a separate approved setup step; activation remains off until cutover.
