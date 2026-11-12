# Telemetry Parity Audit — Every Coding Platform, Mac And Server (2026-10-29)

Refs UM-1625 (freshness and request-field parity), UM-1614 (Mac telemetry hub), UM-1637 (MiniMax runtime, server collectors, Sentry per-event feed).  This audit answers three questions from the owner: what telemetry is actually collected from every coding platform on the Mac and the server, whether a telemetry hub is installed on the server or one is needed, and where breadth, parity and scope should expand next.  The companion reference is the refreshed [`producer-coverage-matrix.md`](../observability/producer-coverage-matrix.md), whose new “Installed State — Live Audit 2026-10-29” section carries the per-producer verdicts.

## Method

Three read-only passes ran in parallel.  The Mac pass inventoried `~/apps/usage-monitor-collectors/`, every `com.jays.*` LaunchAgent, collector logs and the watermarks in `~/.cache/usage-monitor/collector-state/`, plus the local data stores each platform writes (Claude projects, Codex and Grok sessions, the OpenCode sqlite database, the FX usage log, Antigravity status-line state, Kimi Code sessions).  The server pass used the `coolify` SSH host read-only: container and image inventory, systemd units, listening ports, and the producer wiring inside BotFleet, Congress.Trade and Socratic.Trade.  The repository pass mapped every producer row in the coverage matrix against `scripts/*collector*.mjs`, the poll adapters, and the ingest, OTLP metrics, logs and traces routes.  No credentials were printed, no production data was changed, and the only mutation in the whole audit is the Mac LaunchAgent rewiring described under “Fix Landed”.

## Headline Verdicts

1. **Breadth is genuinely wide on tokens.**  Claude Code (transcript feed plus native OTLP when it emits), Codex, Grok Build, DeepSeek/DSH/Clutch, OpenCode and Antigravity quota report into Usage Monitor from the Mac; BotFleet reports every server-hosted seat platform (Claude Code, Codex, Grok, Gemini, DeepSeek, Moonshot Kimi, Cursor Agent, MiniMax); MiniMax desktop runtime turns land since UM-1637.
2. **No telemetry hub is installed anywhere, and none is needed yet.**  See the hub section below.
3. **The weak dimension is not tokens, it is liveness honesty.**  Two producers were silently dark (Antigravity status-line tokens dead since May, Claude subscription quota skipped every pass), one was retired but documented as live (Copilot), and three zero-parsing producers turned out to be healthy-but-idle.  Nothing on the dashboard distinguishes those states today.
4. **Production itself was the largest telemetry gap during the audit.**  A container restart stalled on a pre-migration database backup, every Mac collector failed ingest with HTTP 503 for the duration, token events will replay from watermarks, and quota snapshots from those passes are lost permanently.

## Hub Verdict — Not Installed, Not Needed Yet

Two different hubs exist on paper and neither is running.

**Mac hub (UM-1614).**  `scripts/telemetry-hub/` is code-complete in the installed collector runtime: a loopback OTLP receiver on `127.0.0.1:4318`, a durable journal, and scrubbed Sentry plus full-fidelity Usage Monitor delivery.  It has no LaunchAgent, no process, and no production state directory — only a dry-run directory — so it has never run outside dry-run.  Its rollout still waits on owner decisions recorded in UM-1614.

**Server relay (`fleet-telemetry-relay`).**  AI-Fleet-Coordinator carries a merged design (October 11, PR #500): a pinned `otelcol-contrib` image with one bearer-auth OTLP receiver per producer family and redaction before forwarding.  The server has no such container, image, service, or listener on ports 4317–4321, 9464 or 13133, and no producer points at those ports.  Cutover would need owner-provisioned Coolify service creation and roughly ten Infisical values.

**Why direct ingest stays the recommendation.**  Every current producer already reaches Usage Monitor or Sentry directly, and the server producers carry durable outboxes that retry — strictly stronger delivery than the relay design's in-memory batching, which would add a single point of failure in front of a working path.  Revisit a hub when any of these becomes true: unified agent traces in Sentry are wanted badly enough to pay for a hop; Sentry log volume makes central noise-drop and redaction worth operating; OTLP-native server producers multiply beyond BotFleet's built-in capture; or receiver 503s demonstrably lose batches despite outboxes.  When that day comes, ship the traces route dependency and a persistent queue with it, not after it.

## Platform Parity (Observed 2026-10-29)

| Platform | Tokens | Cost | Quota Windows | Per-Turn Detail | State |
| --- | --- | --- | --- | --- | --- |
| Claude Code | Yes (transcript; native OTLP request metrics quiet since 2026-10-23, UM-1636) | Native estimate via OTLP when emitting; transcript rows token-only | Yes — subscription-quota (fixed 2026-10-29) | Yes — `AiRequest` / `AgentTurn` via logs and traces | Live, with the native-metrics gap already tracked |
| Codex | Yes — session collector | Derived only | Yes | Usage rows; duration where the collector supplies it | Live |
| Grok Build / CLI | Yes — `turn_completed` | Native (`costUsdTicks`) | Yes | Strongest local per-turn feed | Live |
| DeepSeek / DSH / Clutch | Yes — exact message usage | Derived only | No (API balance poll only) | Per-message rows, reasoning in metadata | Live |
| OpenCode | Yes — Mac collector plus server cron | Derived / reported when present | No | Per-message rows with duration | Live; idle on this Mac since 2026-10-28 |
| MiniMax Code | Desktop runtime turns (no model/cost on Mac, UM-1615); `mcode` CLI itself not collected | No on Mac | Yes — two paths, one producer | Runtime ledger turns | Live, quota duplicated by design |
| Antigravity | **No — status-line sink dead since 2026-05-02** | Derived only when tokens exist | Yes — `/usage` collector | Cumulative snapshots, when the sink fires | **Quota-only in practice; repair needs a live CLI session** |
| Muse Code (Meta) | No per-turn ledger exists | No | Yes — 5h and weekly | None | Live, quota-only |
| Muse (VM) | No | No | Yes — VM cron only | None | Live where the binary exists |
| Cursor | No | No | No | Hook turns only (`AgentTurn`) | **Blocked on owner-provisioned Admin API key** (UM-1625) |
| Copilot CLI | Historical only | Derived only | No | Shutdown aggregates | **Retired 2026-10-20 (UM-1618)** |
| Kimi Code | No collector | No | No | None locally; BotFleet's `moonshot-kimi` service covers server seats | Gap — no durable local per-turn feed (matrix gap 8) |
| FX | Yes | No (`total_cost` always 0) | Via Grok | Generation facts | Live; idle on this Mac since 2026-09-25 |
| Fleet seats (BF-*, GB-*, FX, Echo, Jet, Wise, MA…) | Via BotFleet service dimension or their underlying platform | Via platform | Via platform | `AgentTurn` carries seat; the cash ledger has no seat column | Seat is metadata, not a ledger dimension |

## Silent And Stale Producers

| Producer | Symptom | Root Cause | Disposition |
| --- | --- | --- | --- |
| Antigravity status-line | Collector exits 0 every 15 minutes; “parsed 0 since 2026-05-02” | The sink directory `~/.cache/usage-monitor/antigravity-statusline/` does not exist, so the configured statusLine command has never written (or its writes go elsewhere) | Needs a live Antigravity CLI session to prove the sink fires; until then the platform is honestly quota-only |
| Claude subscription quota | `claude=skipped` every pass while Codex/Grok/MiniMax were `ok` | Installed LaunchAgent ran the collector directly; the Keychain wrapper (UM-1616) was never wired into the installed plist | **Fixed 2026-10-29** — see below |
| Copilot | Watermark frozen 2026-10-20 | Owner retired the feed (UM-1618) and the plist was deleted, but the matrix row still said “Live LaunchAgent” | Matrix row corrected in this change |
| Antigravity usage (quota) | launchd reports runs with exit 0, but the configured log file does not exist | Log path drift between plist and collector | Unverifiable from the Mac; flagged for the next install pass |
| FX, OpenCode, MiniMax-runtime | Parse 0 with advancing watermarks | Platforms genuinely idle on this Mac (newest source writes 2026-09-25, 2026-10-28, and no new desktop turns) | Healthy; the gap is that nothing distinguishes this from the Antigravity failure shape |

## Production Outage Observed During The Audit

From about 12:06 pm the public hostname answered 503 `no available server` or timed out for over an hour.  The container was replaced repeatedly in that window (starts at 12:06 pm, 12:17 pm and 12:26 pm, each with `RestartCount` 0 — fresh containers, not crashes), consistent with a queue of the day's merges deploying back-to-back.  Every start runs the pre-migration backup of the 4.1 GB SQLite database (about 11 minutes against a 900-second deadline) on a volume at 92–93% used, and after reaching “Ready” the app still stalls publicly behind 90-second-plus maintenance scans (`external-events-mtd-scan` 93.8 s and `project-budget-scan` 95.4 s over 732,766 October rows) while Litestream compaction fails every ~30 seconds on the replica target.  All Mac token collectors exhausted 8 ingest attempts against the outage; because watermarks only advance on ack, those events replay after recovery with no token loss.  Quota passes in the same window are unrecoverable point-in-time snapshots.  Litestream replication was simultaneously degraded — newest replica about 6.4 hours old and compaction uploads failing on a replica storage-cap error — so the corrective actions are disk headroom and replica health, in that order, before any new telemetry breadth adds write volume.

## Fix Landed With This Audit

The installed `com.jays.subscription-quota-collector` LaunchAgent now runs through `scripts/run-subscription-quota-collector.sh`, matching the repository's `--plists` intent (UM-1616).  The previous plist is preserved beside it as a `.bak-clutch-20261029` file.  The first rewired pass already proved the change: where every earlier pass logged `claude: no Claude Code OAuth credential found` and `claude=skipped`, the rewired pass attempted Claude ingest and failed only on the production outage above.  Once the receiver recovered (health 200 at 12:39 pm), the next scheduled pass logged `claude=ok codex=ok grok=ok minimax=ok grok-bot=ok` — the Claude quota stream is live with no Keychain prompt needed.  The Background Jobs Master List row for this job should be refreshed to name the wrapper at its next update; the live `MAC-LOCAL-PROCESSES.md` row already names the wiring and its date.

## Expansion Roadmap (Ranked)

1. **Receiver resilience first.**  Free disk headroom on the Coolify volume, repair the Litestream replica target, and consider skipping the pre-migration backup stall for no-schema-change restarts.  Every new producer multiplies writes against this disk.
2. **Quota durability.**  Give quota collectors the same watermark/outbox discipline as token collectors, or gate quota passes on receiver health, so an outage stops silently deleting plan-window history (matrix gap 16).
3. **Prove or retire the Antigravity sink.**  One live CLI session with the statusLine sink watched end-to-end; if the CLI no longer fires it, delete the dead collector and document quota-only honestly (matrix gap 15).
4. **Owner decisions already queued.**  Hub go/no-go (UM-1614), the Cursor Admin API key (UM-1625), and the Claude Code native-metrics investigation (UM-1636) each unblock more coverage than any new collector.
5. **Source-missing detection.**  A collector whose declared source directory does not exist should say so in a health event instead of exiting 0 with “parsed 0” (matrix gap 17); the platform-status collector-freshness surface is the natural home.
6. **Seat as a first-class ledger dimension** stays a cross-app wire decision (metadata carries it today; the cash ledger cannot query by seat), and **Kimi Code** stays collector-less until a durable local per-turn feed exists (matrix gap 8).  Both are documented rather than hacked around.

## What Was Not Done

The hub was not installed on either machine (owner decision, UM-1614).  Copilot was not re-enabled (owner retired it, UM-1618).  No Cursor key was provisioned and no producer was pointed at new endpoints.  Nothing in this audit changes the v2 wire, which remains owned by the shared `@jaywedgeworth22/congress-trading-shared` package.
