# Disposable Cancellation Verification Fixture

This file exists only on the isolated CODEX cancellation probe branch.  Its intentionally different addition conflicts with the independently added production rollout document, creating an add/add merge conflict against main.

The probe is not product work and will be closed unmerged.  No conflict resolution, required-check change, policy change or feature-PR mutation is part of this test.

The permitted sequence is an unheld conflict-protected probe, an own-CODEX auto-merge request, and then an explicit hold.  The trusted default-branch guard must cancel using the repository token and verify that auto-merge is absent.

The conflict must remain present until the probe is closed and its branch removed.
