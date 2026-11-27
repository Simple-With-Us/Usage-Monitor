# Worker deployment service credentials

CI uses the finite read-only Fleet-OPS prod `/um-worker-deploy` service token bound as `INFISICAL_UM_WORKER_DEPLOY_READ_TOKEN`. Its source name is `um-worker-deploy-ci-read-20261127`, expiring2027-05-26T14:37:52Z, with a May12 renewal checkpoint.

The folder contains the existing `CLOUDFLARE_FLEET_API_TOKEN` and the dedicated `RECEIPT_INBOX_DEPLOY_HEALTH_TOKEN`. CI fetches both at runtime. The existing Cloudflare deploy credential is privately verified to read the exact receipt R2 lifecycle and supplies mandatory lifecycle verification. No separate audit-token Actions copy is needed.

The health bearer authenticates only existing `/health`, runs unchanged configuration, lifecycle, R2 and Durable Object readiness, and cannot read summary/evidence or change receipt status. Only its SHA256 digest is in Worker configuration. Existing dashboard root read token and Worker runtime credentials are unchanged. No shared root key is moved or reader widened.

The old live Worker accepts only its existing read bearer. One-time bootstrap uses that authorized existing operator credential outside CI for preproof, then exact reviewed publisher promotion, then dedicated health postproof. Routine CI stays off until dedicated postproof succeeds. No receipt data bearer enters CI.

Renew by replacing the exact-folder finite service reader, verifying metadata and intended record reads, sealing it to the repository Actions key, verifying actual runtime delivery, then retiring the old reader. Staging and local tests are not activation or live proof.
