# Repository Report Library

The owner requested saved reports in a consistent per-repository location, plus a central `Code/Docs/<Repo>/` collection using exact GitHub repository names.  `docs/reports/README.md` now indexes the existing records without moving historical files or changing application behavior.

New public-safe reports belong in `docs/reports/`; private operational reports and supporting evidence belong in private Fleet-OPS.  The full Backblaze account audit is being preserved there instead of publishing private operational evidence in this repository.

The shared collector in AI-Fleet-Coordinator reads published Git objects and records source revisions and hashes.  Its central collection is a copy; the repository file remains authoritative.  The owner-approved Docs-only guard exception is installed, and the central collection is populated; Git integration checkouts remain protected.

Validation checks the index's local links against the source Git tree and preserves the historical report paths.  No application source, runtime, backup schedule or credential setting changed.  Shared implementation and collection verification are tracked by AFC-580.
