# Bot-authored pull requests

The Security/gitleaks workflow admits same-repository PR runs triggered by
`cursor[bot]`, `dependabot[bot]`, `sentry[bot]`, `codex[bot]`, and
`chatgpt-codex-connector[bot]`. They still run normal secret scanning and
all other required checks and reviews; admitting a bot is not approving its
code or its merge. The admission gate checks the event `github.actor`, not an
immutable PR-author field. Unknown `[bot]` actors need an owner-approved
allowlist change. Fork PRs remain rejected before checkout.

Keep `.github/workflows/security.yml` aligned with this policy. This note does
not claim other workflows use the same gate or that any deploy-key secret is
present; verify each workflow's current credentials before widening its access.

`chatgpt-codex-connector[bot]` is the observed Codex GitHub reviewer account;
`codex[bot]` remains for compatibility with the earlier requested name.
GitHub uses the event initiator as `github.actor`, so review authorship by itself
does not prove that every Codex-generated PR run uses this actor.
