import { describe, expect, it } from "vitest";
import { projectGeminiExternalBillingForClient } from "@/lib/gemini-external-billing";
import type {
  GeminiBillingStatus,
  GeminiKeyStatus,
} from "@/lib/gemini-key-status";

const records = [
  { source: "google-cloud-billing-export", externalId: "old-cost" },
  { source: "google-gemini-rate-limits", externalId: "quota" },
  { source: "manual-provider-record", externalId: "manual" },
];

function status(
  state: GeminiBillingStatus["state"]
): GeminiBillingStatus {
  return {
    state,
    errorCode: null,
    httpStatus: null,
    retryable: false,
    checkedAt: null,
  };
}

function keyStatus(state: GeminiKeyStatus["state"]): GeminiKeyStatus {
  return {
    state,
    httpStatus: null,
    availableModelCount: null,
    checkedAt: null,
  };
}

describe("projectGeminiExternalBillingForClient", () => {
  it("exposes reconciled Google billing rows only after a ready sync", () => {
    expect(
      projectGeminiExternalBillingForClient(
        records,
        status("ready"),
        keyStatus("valid")
      )
    ).toEqual(records);
  });

  it.each([
    "pending",
    "error",
    "configuration_changed",
    "unchecked",
    "not_configured",
  ] as const)("quarantines unbound Google billing rows while %s", (state) => {
    expect(
      projectGeminiExternalBillingForClient(
        records,
        status(state),
        keyStatus("valid")
      )
    ).toEqual(records.slice(1));
  });

  it.each([
    "invalid",
    "unreadable",
    "unavailable",
    "unchecked",
    "not_configured",
  ] as const)("quarantines old-key quota rows while key is %s", (state) => {
    expect(
      projectGeminiExternalBillingForClient(
        records,
        status("ready"),
        keyStatus(state)
      )
    ).toEqual([records[0], records[2]]);
  });

  it("preserves every row for non-Gemini providers", () => {
    expect(
      projectGeminiExternalBillingForClient(records, null, null)
    ).toEqual(records);
  });
});
