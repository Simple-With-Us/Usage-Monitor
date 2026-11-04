import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";

import { load } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";

const WORKFLOWS = [
  ".github/workflows/auto-merge-prs.yml",
  ".github/workflows/auto-merge-shared-dependency.yml",
];
const REVIEW_SIGNAL_WORKFLOW = ".github/workflows/auto-merge-review-signal.yml";
const HOLD_LABELS = ["do-not-merge", "do-not-automerge", "do-not-auto-merge"];
const HOLD_TITLES = [
  "Do-Not-Merge: waiting",
  "Do Not Merge: waiting",
  "Do-Not-Automerge: waiting",
  "Do Not Automerge: waiting",
  "Do-Not-Auto-Merge: waiting",
  "Do Not Auto-Merge: waiting",
  "Do Not Auto Merge: waiting",
];
const HEAD_SHA = "a".repeat(40);
const REVIEW_MERGE_SHA = "c".repeat(40);
const REPO = "Simple-With-Us/Usage-Monitor";
const REPO_ID = 1284098482;

type WorkflowStep = {
  name: string;
  id?: string;
  if?: string;
  uses?: string;
  run?: string;
};

type WorkflowDocument = {
  on: {
    pull_request_target: { types: string[] };
    workflow_run: { workflows: string[]; types: string[] };
  };
  permissions: Record<string, string>;
  jobs: {
    "auto-merge": {
      if: string;
      steps: WorkflowStep[];
    };
  };
};

const GH_STUB = `#!/usr/bin/env bash
set -u
token_kind=other
if [ "\${GH_TOKEN:-}" = "repo-token" ]; then token_kind=repo; fi
if [ "\${GH_TOKEN:-}" = "merge-token" ]; then token_kind=merge; fi
printf 'token=%s %s\n' "$token_kind" "$*" >> "$STUB_CALLS"
if [ "\${1:-}" = "api" ]; then
  if [[ "$*" == *"/reviews?per_page=100"* ]]; then
    count=0
    if [ -f "$STUB_REVIEW_COUNT" ]; then count=$(cat "$STUB_REVIEW_COUNT"); fi
    count=$((count + 1))
    printf '%s\n' "$count" > "$STUB_REVIEW_COUNT"
    line=$(sed -n "\${count}p" "$STUB_REVIEW_RESPONSES")
    if [ -z "$line" ] || [ "$line" = "__FAIL__" ]; then exit 1; fi
    if [[ "$*" == *"--slurp"* ]]; then
      printf '%s\n' "$line" | jq -c '[.]'
    else
      printf '%s\n' "$line" | jq -r '.[] | [.user.login, .commit_id, .state] | @tsv'
    fi
    exit 0
  fi
  count=0
  if [ -f "$STUB_API_COUNT" ]; then count=$(cat "$STUB_API_COUNT"); fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$STUB_API_COUNT"
  line=$(sed -n "\${count}p" "$STUB_PR_RESPONSES")
  if [ -z "$line" ] || [ "$line" = "__FAIL__" ]; then exit 1; fi
  printf '%s\n' "$line"
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "merge" ] && [ "\${3:-}" = "--disable-auto" ]; then
  if [ "\${STUB_DISABLE_FAIL:-0}" = "1" ]; then exit 1; fi
  exit 0
fi
if [ "\${1:-}" = "pr" ] && [ "\${2:-}" = "merge" ]; then
  count=0
  if [ -f "$STUB_MERGE_COUNT" ]; then count=$(cat "$STUB_MERGE_COUNT"); fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$STUB_MERGE_COUNT"
  if [ "$count" -le "\${STUB_MERGE_FAILURES:-0}" ]; then exit 1; fi
  exit 0
fi
exit 2
`;

const tempRoots = new Set<string>();

afterEach(async () => {
  await Promise.all([...tempRoots].map((root) => rm(root, { recursive: true, force: true })));
  tempRoots.clear();
});

function extractRunBlock(source: string, stepName: string): string {
  const step = `      - name: ${stepName}\n`;
  const stepStart = source.indexOf(step);
  expect(stepStart, `${stepName} step`).toBeGreaterThanOrEqual(0);
  const marker = "        run: |\n";
  const runStart = source.indexOf(marker, stepStart);
  expect(runStart, `${stepName} run block`).toBeGreaterThanOrEqual(0);
  const lines = source.slice(runStart + marker.length).split("\n");
  const body: string[] = [];
  for (const line of lines) {
    if (line === "" || line.startsWith("          ")) {
      body.push(line.startsWith("          ") ? line.slice(10) : "");
      continue;
    }
    break;
  }
  return body.join("\n").trimEnd();
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 1876,
    base: { repo: { full_name: REPO } },
    state: "open",
    draft: false,
    title: "Bump congress-trading-shared",
    labels: [],
    head: {
      repo: { full_name: REPO },
      sha: HEAD_SHA,
      ref: "dependabot/shared-package",
    },
    auto_merge: null,
    ...overrides,
  };
}

function workflowRunPullRequest(overrides: Record<string, unknown> = {}) {
  const repository = {
    id: REPO_ID,
    name: "Usage-Monitor",
    url: `https://api.github.com/repos/${REPO}`,
  };
  return {
    base: { ref: "main", repo: repository, sha: "b".repeat(40) },
    head: { ref: "codex/feature", repo: repository, sha: HEAD_SHA },
    id: 5139873620,
    number: 1876,
    url: `https://api.github.com/repos/${REPO}/pulls/1876`,
    ...overrides,
  };
}

function review(state: string, login = "kody-ai[bot]", commitId = HEAD_SHA) {
  return { user: { login }, commit_id: commitId, state };
}

async function runBlock(
  script: string,
  responses: Array<unknown | "__FAIL__">,
  options: {
    disableFails?: boolean;
    hasElevatedToken?: boolean;
    eventPrNumber?: string;
    mergeFailures?: number;
    reviewHeadSha?: string;
    reviewPullRequests?: unknown;
    reviewPullRequestsJson?: string;
    reviewResponses?: Array<unknown | "__FAIL__">;
    repoId?: string;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "um-auto-merge-hold-"));
  tempRoots.add(root);
  const bin = join(root, "bin");
  const gh = join(bin, "gh");
  const output = join(root, "output");
  const summary = join(root, "summary");
  const calls = join(root, "calls");
  const apiCount = join(root, "api-count");
  const reviewCount = join(root, "review-count");
  const mergeCount = join(root, "merge-count");
  const responseFile = join(root, "responses");
  const reviewResponseFile = join(root, "review-responses");
  const reviewResponses = options.reviewResponses ?? [[review("APPROVED")], [review("APPROVED")]];
  await mkdir(bin);
  await Promise.all([
    writeFile(gh, GH_STUB),
    writeFile(output, ""),
    writeFile(summary, ""),
    writeFile(calls, ""),
    writeFile(responseFile, `${responses.map((value) => value === "__FAIL__" ? value : JSON.stringify(value)).join("\n")}\n`),
    writeFile(reviewResponseFile, `${reviewResponses.map((value) => value === "__FAIL__" ? value : JSON.stringify(value)).join("\n")}\n`),
  ]);
  await chmod(gh, 0o755);
  const result = spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      GITHUB_STEP_SUMMARY: summary,
      GH_TOKEN: "repo-token",
      REPO_TOKEN: "repo-token",
      MERGE_TOKEN: "merge-token",
      HAS_ELEVATED_TOKEN: options.hasElevatedToken ? "1" : "0",
      REPO,
      PR_NUMBER: "1876",
      EVENT_PR_NUMBER: options.eventPrNumber ?? "1876",
      REVIEW_HEAD_SHA: options.reviewHeadSha ?? "",
      REVIEW_PULL_REQUESTS: options.reviewPullRequestsJson ?? JSON.stringify(options.reviewPullRequests === undefined ? [] : options.reviewPullRequests),
      REPO_ID: options.repoId ?? String(REPO_ID),
      PR_URL: "https://github.com/Simple-With-Us/Usage-Monitor/pull/1876",
      EXPECTED_HEAD: HEAD_SHA,
      HEAD_SHA,
      STUB_CALLS: calls,
      STUB_API_COUNT: apiCount,
      STUB_REVIEW_COUNT: reviewCount,
      STUB_MERGE_COUNT: mergeCount,
      STUB_PR_RESPONSES: responseFile,
      STUB_REVIEW_RESPONSES: reviewResponseFile,
      STUB_DISABLE_FAIL: options.disableFails ? "1" : "0",
      STUB_MERGE_FAILURES: String(options.mergeFailures ?? 0),
    },
  });
  const outputEntries = Object.fromEntries(
    (await readFile(output, "utf8"))
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  return {
    ...result,
    calls: await readFile(calls, "utf8"),
    output: outputEntries,
  };
}

describe("auto-merge hold guards", () => {
  it.each(WORKFLOWS)("declares every hold transition and keeps privileged code inline in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const parsed = load(source) as WorkflowDocument;
    expect(Object.keys(parsed.on)).toEqual(["pull_request_target", "workflow_run"]);
    expect(parsed.on.pull_request_target.types).toEqual(expect.arrayContaining([
      "opened", "synchronize", "reopened", "labeled", "unlabeled", "edited",
      "converted_to_draft", "ready_for_review", "auto_merge_enabled",
    ]));
    expect(parsed.on.workflow_run).toEqual({
      workflows: ["Auto-merge review signal"],
      types: ["completed"],
    });
    for (const event of ["edited", "unlabeled", "converted_to_draft", "auto_merge_enabled"]) {
      expect(source).toContain(event);
    }
    expect(source).not.toContain("uses: actions/checkout");
    const job = parsed.jobs["auto-merge"];
    expect(job.if).toContain("github.event_name == 'pull_request_target'");
    expect(job.if).toContain("github.event_name == 'workflow_run'");
    expect(job.if).toContain("github.event.workflow_run.event == 'pull_request_review'");
    expect(job.if).toContain("github.event.workflow_run.head_repository.full_name == github.repository");
    expect(job.if).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(job.steps.some((step) => step.uses)).toBe(false);
    const liveStep = job.steps.find((step) => step.id === "live");
    const approvalStep = job.steps.find((step) => step.id === "approval");
    const identityStep = job.steps.find((step) => step.id === "identity");
    const disarmStep = job.steps.find((step) => step.name.startsWith("Disarm a held"));
    const enableStep = job.steps.find((step) => step.name.startsWith("Enable auto-merge"));
    expect(liveStep?.run).toContain('gh api "repos/$REPO/pulls/$PR_NUMBER"');
    expect(source).not.toContain("github.event.workflow_run.head_sha");
    expect(liveStep?.run).not.toContain('repos/$REPO/pulls?state=open&per_page=100');
    expect(liveStep?.run).toContain('REVIEW_PULL_REQUESTS');
    expect(liveStep?.run).toContain('echo "pr_number=$PR_NUMBER"');
    expect(identityStep?.if).toBe("steps.live.outputs.armable == '1'");
    expect(approvalStep?.if).toBe("steps.live.outputs.armable == '1'");
    expect(disarmStep?.if).toContain("steps.live.outputs.disarm == '1'");
    expect(disarmStep?.if).toContain("steps.identity.outputs.arm == '1'");
    expect(disarmStep?.if).toContain("steps.approval.outputs.ok != '1'");
    expect(enableStep?.if).toContain("steps.live.outputs.armable == '1'");
    expect(enableStep?.if).toContain("steps.identity.outputs.arm == '1'");
    expect(enableStep?.if).toContain("steps.approval.outputs.ok == '1'");
    expect(source).toContain("HEAD_SHA: ${{ steps.live.outputs.head_sha }}");
    expect(source).toContain("PR_NUMBER: ${{ steps.live.outputs.pr_number }}");
    const enable = extractRunBlock(source, workflow.includes("shared") ? "Enable auto-merge" : "Enable auto-merge (squash + delete branch)");
    expect(enable.match(/--match-head-commit \"\$EXPECTED_HEAD\"/g)).toHaveLength(2);
    expect(enable).toContain('GH_TOKEN="$REPO_TOKEN" gh api');
    expect(enable).toContain('GH_TOKEN="$REPO_TOKEN" gh api --paginate --slurp');
    expect(enable.match(/if ! kody_approval_current;/g)).toHaveLength(2);
    expect(enable).toContain('GH_TOKEN="$MERGE_TOKEN" gh pr merge --auto');
  });

  it("keeps the review-event notifier unprivileged", async () => {
    const source = await readFile(REVIEW_SIGNAL_WORKFLOW, "utf8");
    const parsed = load(source) as {
      on: { pull_request_review: { types: string[] } };
      permissions: Record<string, string>;
      jobs: { signal: { if: string; steps: WorkflowStep[] } };
    };
    expect(Object.keys(parsed.on)).toEqual(["pull_request_review"]);
    expect(parsed.on.pull_request_review.types).toEqual(["submitted", "dismissed"]);
    expect(parsed.permissions).toEqual({});
    expect(parsed.jobs.signal.if).toBe("github.event.pull_request.head.repo.full_name == github.repository");
    expect(parsed.jobs.signal.steps.some((step) => step.uses)).toBe(false);
    expect(source).not.toMatch(/secrets\.|GH_TOKEN|actions\/checkout/);
  });

  it.each(WORKFLOWS)("uses live state to block every hold form in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const initial = extractRunBlock(source, workflow.includes("shared") ? "Read live shared-PR merge eligibility" : "Read live PR merge eligibility");
    const healthy = await runBlock(initial, [pullRequest()]);
    expect(healthy.status).toBe(0);
    expect(healthy.output).toMatchObject({ armable: "1", disarm: "0", head_sha: HEAD_SHA });

    for (const label of HOLD_LABELS) {
      const held = await runBlock(initial, [pullRequest({ labels: [{ name: label.toUpperCase() }] })]);
      expect(held.status, label).toBe(0);
      expect(held.output).toMatchObject({ armable: "0", disarm: "1", head_sha: "" });
    }
    for (const title of HOLD_TITLES) {
      const held = await runBlock(initial, [pullRequest({ title })]);
      expect(held.status, title).toBe(0);
      expect(held.output).toMatchObject({ armable: "0", disarm: "1", head_sha: "" });
    }

    const draft = await runBlock(initial, [pullRequest({ draft: true })]);
    expect(draft.output).toMatchObject({ armable: "0", disarm: "1" });
    const unavailable = await runBlock(initial, ["__FAIL__"]);
    expect(unavailable.status).toBe(0);
    expect(unavailable.output).toMatchObject({ armable: "0", disarm: "1" });
    const malformed = await runBlock(initial, [{}]);
    expect(malformed.status).toBe(0);
    expect(malformed.output).toMatchObject({ armable: "0", disarm: "1" });
  });

  it.each(WORKFLOWS)("resolves review metadata independently of the workflow merge-ref SHA in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const initial = extractRunBlock(source, workflow.includes("shared") ? "Read live shared-PR merge eligibility" : "Read live PR merge eligibility");
    const resolved = await runBlock(initial, [pullRequest()], {
      eventPrNumber: "",
      reviewHeadSha: REVIEW_MERGE_SHA,
      reviewPullRequests: [workflowRunPullRequest()],
    });
    expect(resolved.status).toBe(0);
    expect(resolved.output).toMatchObject({
      armable: "1",
      disarm: "0",
      head_sha: HEAD_SHA,
      pr_number: "1876",
    });
    expect(REVIEW_MERGE_SHA).not.toBe(HEAD_SHA);
    expect(resolved.calls.trim()).toBe(`token=repo api repos/${REPO}/pulls/1876`);
  });

  it.each(WORKFLOWS)("rejects missing, malformed, ambiguous, or foreign review metadata in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const initial = extractRunBlock(source, workflow.includes("shared") ? "Read live shared-PR merge eligibility" : "Read live PR merge eligibility");
    const invalidMetadata = [
      [], null, {}, "not-an-array", [null], ["not-a-PR"], [{}],
      [workflowRunPullRequest(), workflowRunPullRequest({ number: 1877 })],
      [workflowRunPullRequest(), {}],
      ...[undefined, null, "1876", 0, -1, 1876.5, 9007199254740992].map((number) => [workflowRunPullRequest({ number })]),
      ...[undefined, null, "not-a-sha", "a".repeat(39), "a".repeat(41), "g".repeat(40), 42].map((sha) => [workflowRunPullRequest({
        head: { repo: { id: REPO_ID }, sha },
      })]),
      ...["base", "head"].flatMap((side) => [undefined, null, 42, String(REPO_ID)].map((id) => [workflowRunPullRequest({
        [side]: { repo: { id }, sha: HEAD_SHA },
      })])),
    ];
    for (const metadata of invalidMetadata) {
      const rejected = await runBlock(initial, [], {
        eventPrNumber: "",
        reviewHeadSha: REVIEW_MERGE_SHA,
        reviewPullRequests: metadata,
      });
      expect(rejected.status, JSON.stringify(metadata)).not.toBe(0);
      expect(rejected.output).toMatchObject({ armable: "0", disarm: "1", pr_number: "", head_sha: "" });
      expect(rejected.calls).toBe("");
      expect(rejected.stdout).toContain("no PR could be identified safely and cancellation was not attempted");
    }
    for (const reviewPullRequestsJson of ["", "{", "[invalid]"]) {
      const rejected = await runBlock(initial, [], { eventPrNumber: "", reviewPullRequestsJson });
      expect(rejected.status).not.toBe(0);
      expect(rejected.calls).toBe("");
      expect(rejected.stdout).toContain("no PR could be identified safely and cancellation was not attempted");
    }
    for (const repoId of ["", "0", "invalid", "42"]) {
      const rejected = await runBlock(initial, [], {
        eventPrNumber: "", repoId, reviewPullRequests: [workflowRunPullRequest()],
      });
      expect(rejected.status).not.toBe(0);
      expect(rejected.calls).toBe("");
      expect(rejected.stdout).toContain("no PR could be identified safely and cancellation was not attempted");
    }
  });

  it.each(WORKFLOWS)("disarms a review signal when its metadata head is stale in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const initial = extractRunBlock(source, workflow.includes("shared") ? "Read live shared-PR merge eligibility" : "Read live PR merge eligibility");
    const armed = pullRequest({
      head: { repo: { full_name: REPO }, sha: REVIEW_MERGE_SHA, ref: "dependabot/shared-package" },
      auto_merge: { enabled_by: { login: "owner" } },
    });
    const stale = await runBlock(initial, [armed], {
      eventPrNumber: "",
      reviewHeadSha: REVIEW_MERGE_SHA,
      reviewPullRequests: [workflowRunPullRequest()],
    });
    expect(stale.status).toBe(0);
    expect(stale.output).toMatchObject({ armable: "0", disarm: "1", head_sha: "", pr_number: "1876" });
    const disarm = extractRunBlock(source, "Disarm a held, draft, unreadable, or unapproved PR");
    const canceled = await runBlock(disarm, [armed, pullRequest()]);
    expect(canceled.status).toBe(0);
    expect(canceled.calls).toContain("token=repo pr merge --disable-auto");
  });

  it.each(WORKFLOWS)("requires Kody's latest current-head review state to be APPROVED in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const approval = extractRunBlock(source, "Require a current-head approval from the fleet reviewer");
    const commentedAfterApproval = await runBlock(approval, [], { reviewResponses: [[
      review("APPROVED"),
      review("COMMENTED"),
    ]] });
    expect(commentedAfterApproval.status).toBe(0);
    expect(commentedAfterApproval.output.ok).toBe("0");

    const approvedLast = await runBlock(approval, [], { reviewResponses: [[
      review("COMMENTED"),
      review("APPROVED"),
    ]] });
    expect(approvedLast.status).toBe(0);
    expect(approvedLast.output.ok).toBe("1");

    const unrelatedComment = await runBlock(approval, [], { reviewResponses: [[
      review("APPROVED"),
      review("COMMENTED", "human-reviewer"),
      review("APPROVED", "kody-ai[bot]", "d".repeat(40)),
    ]] });
    expect(unrelatedComment.status).toBe(0);
    expect(unrelatedComment.output.ok).toBe("1");
    expect(unrelatedComment.calls).toContain("--paginate");
  });

  it("does not let the shared workflow cancel a healthy unrelated PR", async () => {
    const source = await readFile(WORKFLOWS[1], "utf8");
    const initial = extractRunBlock(source, "Read live shared-PR merge eligibility");
    const unrelated = await runBlock(initial, [pullRequest({ title: "Ordinary change", head: { repo: { full_name: REPO }, sha: HEAD_SHA, ref: "codex/ordinary" } })]);
    expect(unrelated.status).toBe(0);
    expect(unrelated.output).toMatchObject({ armable: "0", disarm: "0" });
  });

  it.each(WORKFLOWS)("preserves manual arming without an elevated token while always disarming holds and drafts in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const parsed = load(source) as WorkflowDocument;
    const condition = parsed.jobs["auto-merge"].steps.find((step) => step.name.startsWith("Disarm a held"))?.if;
    expect(condition).toBeDefined();
    const initial = extractRunBlock(source, workflow.includes("shared") ? "Read live shared-PR merge eligibility" : "Read live PR merge eligibility");
    const identity = extractRunBlock(source, "Check for an elevated (non-GITHUB_TOKEN) merge identity");
    const approval = extractRunBlock(source, "Require a current-head approval from the fleet reviewer");
    const healthy = await runBlock(initial, [pullRequest()]);
    const unapproved = await runBlock(approval, [], { reviewResponses: [[review("COMMENTED")]] });
    expect(healthy.status).toBe(0);
    expect(unapproved.status).toBe(0);
    expect(unapproved.output.ok).toBe("0");
    const held = await runBlock(initial, [pullRequest({ title: "Do-Not-Merge: waiting" })]);
    const drafted = await runBlock(initial, [pullRequest({ draft: true })]);
    expect(held.status).toBe(0);
    expect(drafted.status).toBe(0);

    for (const hasElevatedToken of [false, true]) {
      const token = await runBlock(identity, [], { hasElevatedToken });
      expect(token.status).toBe(0);
      expect(token.output.arm).toBe(hasElevatedToken ? "1" : "0");
      const shouldDisarm = (live: Record<string, string>, ok: string) => runInNewContext(condition!, {
        steps: {
          live: { outputs: live },
          identity: { outputs: token.output },
          approval: { outputs: { ok } },
        },
      });
      expect(shouldDisarm(healthy.output, unapproved.output.ok)).toBe(hasElevatedToken);
      expect(shouldDisarm(healthy.output, "1")).toBe(false);
      expect(shouldDisarm(held.output, "1")).toBe(true);
      expect(shouldDisarm(drafted.output, "1")).toBe(true);
    }
    expect(runInNewContext(condition!, {
      steps: {
        live: { outputs: held.output },
        identity: { outputs: {} },
        approval: { outputs: {} },
      },
    })).toBe(true);
  });

  it.each(WORKFLOWS)("verifies cancellation instead of hiding failures in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const disarm = extractRunBlock(source, "Disarm a held, draft, unreadable, or unapproved PR");
    const armed = pullRequest({ auto_merge: { enabled_by: { login: "owner" } } });
    const canceled = await runBlock(disarm, [armed, pullRequest()]);
    expect(canceled.status).toBe(0);
    expect(canceled.calls).toContain("token=repo pr merge --disable-auto");

    const alreadyClear = await runBlock(disarm, [pullRequest()]);
    expect(alreadyClear.status).toBe(0);
    expect(alreadyClear.calls).not.toContain("--disable-auto");

    const failed = await runBlock(disarm, [armed], { disableFails: true });
    expect(failed.status).not.toBe(0);

    const missingState = await runBlock(disarm, [{}]);
    expect(missingState.status).not.toBe(0);
    const missingAutoMerge = await runBlock(disarm, [pullRequest({ auto_merge: undefined })]);
    expect(missingAutoMerge.status).not.toBe(0);
    const stillArmed = await runBlock(disarm, [armed, armed]);
    expect(stillArmed.status).not.toBe(0);
    const malformedAfter = await runBlock(disarm, [armed, {}]);
    expect(malformedAfter.status).not.toBe(0);
  });

  it.each(WORKFLOWS)("rechecks live holds and the approved head immediately before every merge in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const enable = extractRunBlock(source, workflow.includes("shared") ? "Enable auto-merge" : "Enable auto-merge (squash + delete branch)");
    const healthy = await runBlock(enable, [pullRequest()]);
    expect(healthy.status).toBe(0);
    expect(healthy.calls).toContain(`token=merge pr merge --auto --squash --delete-branch --match-head-commit ${HEAD_SHA}`);
    expect(healthy.calls).toContain(`token=repo api --paginate --slurp repos/${REPO}/pulls/1876/reviews?per_page=100`);

    const armedHeld = pullRequest({ title: "Do-Not-Merge: waiting", auto_merge: { enabled_by: { login: "owner" } } });
    const held = await runBlock(enable, [armedHeld, armedHeld, pullRequest({ title: "Do-Not-Merge: waiting" })]);
    expect(held.status).toBe(0);
    expect(held.calls).not.toContain("pr merge --auto");
    expect(held.calls).toContain("token=repo pr merge --disable-auto");

    const changedHead = pullRequest({ head: { repo: { full_name: REPO }, sha: "b".repeat(40), ref: "dependabot/shared-package" }, auto_merge: { enabled_by: { login: "owner" } } });
    const changed = await runBlock(enable, [changedHead, changedHead, pullRequest({ head: { repo: { full_name: REPO }, sha: "b".repeat(40), ref: "dependabot/shared-package" } })]);
    expect(changed.status).toBe(0);
    expect(changed.calls).not.toContain("pr merge --auto");
    expect(changed.calls).toContain("token=repo pr merge --disable-auto");

    const malformedResponses = [
      pullRequest({ title: undefined }),
      pullRequest({ labels: null }),
      pullRequest({ labels: [{ name: 42 }] }),
    ];
    for (const malformed of malformedResponses) {
      const refused = await runBlock(enable, [malformed, pullRequest()]);
      expect(refused.status).toBe(0);
      expect(refused.calls).not.toContain("pr merge --auto");

      const refusedFallback = await runBlock(enable, [pullRequest(), malformed, pullRequest()], { mergeFailures: 1 });
      expect(refusedFallback.status).toBe(0);
      expect(refusedFallback.calls.split("\n").filter((line) => line.includes("pr merge --auto"))).toHaveLength(1);
    }

    if (workflow.includes("shared")) {
      const ordinary = pullRequest({
        title: "Ordinary change",
        head: { repo: { full_name: REPO }, sha: HEAD_SHA, ref: "codex/ordinary" },
        auto_merge: { enabled_by: { login: "owner" } },
      });
      const reclassified = await runBlock(enable, [ordinary]);
      expect(reclassified.status).toBe(0);
      expect(reclassified.calls).not.toContain("pr merge --auto");
      expect(reclassified.calls).not.toContain("--disable-auto");

      const reclassifiedFallback = await runBlock(enable, [pullRequest(), ordinary], { mergeFailures: 1 });
      expect(reclassifiedFallback.status).toBe(0);
      expect(reclassifiedFallback.calls.split("\n").filter((line) => line.includes("pr merge --auto"))).toHaveLength(1);
      expect(reclassifiedFallback.calls).not.toContain("--disable-auto");
    }

    const fallback = await runBlock(enable, [pullRequest(), pullRequest()], { mergeFailures: 1 });
    expect(fallback.status).toBe(0);
    const mergeCalls = fallback.calls.split("\n").filter((line) => line.includes("pr merge --auto"));
    expect(mergeCalls).toHaveLength(2);
    expect(mergeCalls.every((line) => line.includes(`--match-head-commit ${HEAD_SHA}`))).toBe(true);
    expect(fallback.calls.split("\n").filter((line) => line.includes("/reviews?per_page=100"))).toHaveLength(2);

    const fallbackHeld = await runBlock(
      enable,
      [pullRequest(), armedHeld, armedHeld, pullRequest({ title: "Do-Not-Merge: waiting" })],
      { mergeFailures: 1 },
    );
    expect(fallbackHeld.status).toBe(0);
    expect(fallbackHeld.calls.split("\n").filter((line) => line.includes("pr merge --auto"))).toHaveLength(1);
    expect(fallbackHeld.calls).toContain("token=repo pr merge --disable-auto");
  });

  it.each(WORKFLOWS)("rechecks current Kody approval before the first arm and merge fallback in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const enable = extractRunBlock(source, workflow.includes("shared") ? "Enable auto-merge" : "Enable auto-merge (squash + delete branch)");
    const armed = pullRequest({ auto_merge: { enabled_by: { login: "owner" } } });
    const unavailableApprovals = [
      "__FAIL__", [], {},
      [review("APPROVED"), review("DISMISSED")],
      [review("APPROVED"), review("CHANGES_REQUESTED")],
      [review("APPROVED"), review("COMMENTED")],
      [review("APPROVED", "human-reviewer")],
      [review("APPROVED", "kody-ai[bot]", "d".repeat(40))],
      [review("APPROVED"), { user: { login: "kody-ai[bot]" } }],
    ];
    for (const reviews of unavailableApprovals) {
      const beforeFirstArm = await runBlock(enable, [armed, armed, pullRequest()], {
        reviewResponses: [reviews],
      });
      expect(beforeFirstArm.status, JSON.stringify(reviews)).toBe(0);
      expect(beforeFirstArm.calls).not.toContain("pr merge --auto");
      expect(beforeFirstArm.calls).toContain("token=repo pr merge --disable-auto");

      const beforeFallback = await runBlock(enable, [armed, armed, armed, pullRequest()], {
        mergeFailures: 1,
        reviewResponses: [[review("APPROVED")], reviews],
      });
      expect(beforeFallback.status, JSON.stringify(reviews)).toBe(0);
      expect(beforeFallback.calls.split("\n").filter((line) => line.includes("pr merge --auto"))).toHaveLength(1);
      expect(beforeFallback.calls).not.toContain("pr merge --auto --merge");
      expect(beforeFallback.calls).toContain("token=repo pr merge --disable-auto");
    }
    const failedCancellation = await runBlock(enable, [armed, armed], {
      disableFails: true,
      reviewResponses: [[review("DISMISSED")]],
    });
    expect(failedCancellation.status).not.toBe(0);
    expect(failedCancellation.calls).not.toContain("pr merge --auto");
    const stillArmed = await runBlock(enable, [armed, armed, armed], {
      reviewResponses: [[review("DISMISSED")]],
    });
    expect(stillArmed.status).not.toBe(0);
    expect(stillArmed.calls).not.toContain("pr merge --auto");
  });
});
