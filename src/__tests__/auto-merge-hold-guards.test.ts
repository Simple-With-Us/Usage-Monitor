import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

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
const REVIEW_SIGNAL_SHA = "c".repeat(40);
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
  count=0
  if [ -f "$STUB_API_COUNT" ]; then count=$(cat "$STUB_API_COUNT"); fi
  count=$((count + 1))
  printf '%s\n' "$count" > "$STUB_API_COUNT"
  line=$(sed -n "\${count}p" "$STUB_PR_RESPONSES")
  if [ -z "$line" ] || [ "$line" = "__FAIL__" ]; then exit 1; fi
  if [[ "$*" == *"/reviews?per_page=100"* ]]; then
    printf '%s\n' "$line" | jq -r '.[] | [.user.login, .commit_id, .state] | @tsv'
  else
    printf '%s\n' "$line"
  fi
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
    head: { ref: "codex/feature", repo: repository, sha: REVIEW_SIGNAL_SHA },
    id: 5139873620,
    number: 1876,
    url: `https://api.github.com/repos/${REPO}/pulls/1876`,
    ...overrides,
  };
}

async function runBlock(
  script: string,
  responses: Array<unknown | "__FAIL__">,
  options: {
    disableFails?: boolean;
    eventPrNumber?: string;
    mergeFailures?: number;
    reviewHeadSha?: string;
    reviewPullRequests?: unknown;
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
  const mergeCount = join(root, "merge-count");
  const responseFile = join(root, "responses");
  await mkdir(bin);
  await Promise.all([
    writeFile(gh, GH_STUB),
    writeFile(output, ""),
    writeFile(summary, ""),
    writeFile(calls, ""),
    writeFile(responseFile, `${responses.map((value) => value === "__FAIL__" ? value : JSON.stringify(value)).join("\n")}\n`),
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
      REPO,
      PR_NUMBER: "1876",
      EVENT_PR_NUMBER: options.eventPrNumber ?? "1876",
      REVIEW_HEAD_SHA: options.reviewHeadSha ?? "",
      REVIEW_PULL_REQUESTS: JSON.stringify(options.reviewPullRequests ?? []),
      REPO_ID: options.repoId ?? String(REPO_ID),
      PR_URL: "https://github.com/Simple-With-Us/Usage-Monitor/pull/1876",
      EXPECTED_HEAD: HEAD_SHA,
      HEAD_SHA,
      STUB_CALLS: calls,
      STUB_API_COUNT: apiCount,
      STUB_MERGE_COUNT: mergeCount,
      STUB_PR_RESPONSES: responseFile,
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
    expect(liveStep?.run).toContain('repos/$REPO/pulls?state=open&per_page=100');
    expect(liveStep?.run).toContain('REVIEW_PULL_REQUESTS');
    expect(liveStep?.run).toContain('echo "pr_number=$PR_NUMBER"');
    expect(identityStep?.if).toBe("steps.live.outputs.armable == '1'");
    expect(approvalStep?.if).toBe("steps.live.outputs.armable == '1'");
    expect(disarmStep?.if).toContain("steps.live.outputs.disarm == '1'");
    expect(disarmStep?.if).toContain("steps.approval.outputs.ok != '1'");
    expect(enableStep?.if).toContain("steps.live.outputs.armable == '1'");
    expect(enableStep?.if).toContain("steps.identity.outputs.arm == '1'");
    expect(enableStep?.if).toContain("steps.approval.outputs.ok == '1'");
    expect(source).toContain("HEAD_SHA: ${{ steps.live.outputs.head_sha }}");
    expect(source).toContain("PR_NUMBER: ${{ steps.live.outputs.pr_number }}");
    const enable = extractRunBlock(source, workflow.includes("shared") ? "Enable auto-merge" : "Enable auto-merge (squash + delete branch)");
    expect(enable.match(/--match-head-commit \"\$EXPECTED_HEAD\"/g)).toHaveLength(2);
    expect(enable).toContain('GH_TOKEN="$REPO_TOKEN" gh api');
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

  it.each(WORKFLOWS)("resolves a review signal to one live same-repository PR in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const initial = extractRunBlock(source, workflow.includes("shared") ? "Read live shared-PR merge eligibility" : "Read live PR merge eligibility");
    const resolved = await runBlock(initial, [pullRequest()], {
      eventPrNumber: "",
      reviewHeadSha: REVIEW_SIGNAL_SHA,
      reviewPullRequests: [workflowRunPullRequest()],
    });
    expect(resolved.status).toBe(0);
    expect(resolved.output).toMatchObject({
      armable: "1",
      disarm: "0",
      head_sha: HEAD_SHA,
      pr_number: "1876",
    });
    expect(resolved.calls).not.toContain("?state=open");

    const second = workflowRunPullRequest({ id: 5139873621, number: 1877 });
    const ambiguousMetadata = await runBlock(initial, [], {
      eventPrNumber: "",
      reviewHeadSha: REVIEW_SIGNAL_SHA,
      reviewPullRequests: [workflowRunPullRequest(), second],
    });
    expect(ambiguousMetadata.status).not.toBe(0);

    const wrongRepository = workflowRunPullRequest({
      head: { ref: "fork", repo: { id: 42 }, sha: REVIEW_SIGNAL_SHA },
    });
    const noMetadataCandidate = await runBlock(initial, [], {
      eventPrNumber: "",
      reviewHeadSha: REVIEW_SIGNAL_SHA,
      reviewPullRequests: [wrongRepository],
    });
    expect(noMetadataCandidate.status).not.toBe(0);

    const associated = pullRequest({
      head: { repo: { full_name: REPO }, sha: REVIEW_SIGNAL_SHA, ref: "codex/feature" },
    });
    const fallback = await runBlock(initial, [[[associated]], pullRequest()], {
      eventPrNumber: "",
      reviewHeadSha: REVIEW_SIGNAL_SHA,
      reviewPullRequests: [],
    });
    expect(fallback.status).toBe(0);
    expect(fallback.output.pr_number).toBe("1876");
    expect(fallback.calls).toContain(`repos/${REPO}/pulls?state=open&per_page=100`);

    const fallbackAmbiguous = await runBlock(initial, [[[associated, pullRequest({
      number: 1877,
      head: { repo: { full_name: REPO }, sha: REVIEW_SIGNAL_SHA, ref: "codex/feature" },
    })]]], {
      eventPrNumber: "",
      reviewHeadSha: REVIEW_SIGNAL_SHA,
      reviewPullRequests: [],
    });
    expect(fallbackAmbiguous.status).not.toBe(0);

    const invalidSha = await runBlock(initial, [], {
      eventPrNumber: "",
      reviewHeadSha: "not-a-sha",
      reviewPullRequests: [workflowRunPullRequest()],
    });
    expect(invalidSha.status).not.toBe(0);
    expect(invalidSha.calls).toBe("");
  });

  it.each(WORKFLOWS)("requires Kody's latest current-head review state to be APPROVED in %s", async (workflow) => {
    const source = await readFile(workflow, "utf8");
    const approval = extractRunBlock(source, "Require a current-head approval from the fleet reviewer");
    const review = (state: string, login = "kody-ai[bot]", commitId = HEAD_SHA) => ({
      user: { login },
      commit_id: commitId,
      state,
    });

    const commentedAfterApproval = await runBlock(approval, [[
      review("APPROVED"),
      review("COMMENTED"),
    ]]);
    expect(commentedAfterApproval.status).toBe(0);
    expect(commentedAfterApproval.output.ok).toBe("0");

    const approvedLast = await runBlock(approval, [[
      review("COMMENTED"),
      review("APPROVED"),
    ]]);
    expect(approvedLast.status).toBe(0);
    expect(approvedLast.output.ok).toBe("1");

    const unrelatedComment = await runBlock(approval, [[
      review("APPROVED"),
      review("COMMENTED", "human-reviewer"),
      review("APPROVED", "kody-ai[bot]", "d".repeat(40)),
    ]]);
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

    const fallbackHeld = await runBlock(
      enable,
      [pullRequest(), armedHeld, armedHeld, pullRequest({ title: "Do-Not-Merge: waiting" })],
      { mergeFailures: 1 },
    );
    expect(fallbackHeld.status).toBe(0);
    expect(fallbackHeld.calls.split("\n").filter((line) => line.includes("pr merge --auto"))).toHaveLength(1);
    expect(fallbackHeld.calls).toContain("token=repo pr merge --disable-auto");
  });
});
