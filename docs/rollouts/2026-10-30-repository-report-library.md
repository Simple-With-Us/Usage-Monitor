# Repository Report Library

The owner requested saved reports in a consistent per-repository location, plus a central `Code/Docs/<Repo>/` collection using exact GitHub repository names.  `docs/reports/README.md` now indexes the existing records without moving historical files or changing application behavior.

New public-safe reports belong in `docs/reports/`; private operational reports and supporting evidence belong in private Fleet-OPS.  The full Backblaze account audit is being preserved there instead of publishing private operational evidence in this repository.

The shared collector in AI-Fleet-Coordinator reads published Git objects and records source revisions and hashes.  Its central collection is a copy; the repository file remains authoritative.  The initial, pre-approval placement caveat was:

> Final central placement depends on a narrow owner-approved exception to the server lane guard, which currently protects the entire Code root.

## Placement Update — October 30, 2026

The owner approved the Docs-only exception, which is installed; Git integration checkouts remain protected.  Verification against the installed guard passed eight dedicated Docs cases and ten existing baseline cases.  The [private installation receipt](https://github.com/Simple-With-Us/Fleet-OPS/blob/402192b40ec45d719cea70f915461f8788ab2b79/docs/reports/evidence/2026-10-30-docs-guard-installation.jsonl) records the before/after guard hashes and unchanged configuration/registration digests.  The initial central collection covers 16 repositories; the collector's subsequent check returned `validated 0 planned operation(s)`.  Final source refresh follows repository delivery.

Validation checks the index's local links against the source Git tree and preserves the historical report paths.  No application source, runtime, backup schedule or credential setting changed.  Shared implementation and collection verification are tracked by AFC-580.
