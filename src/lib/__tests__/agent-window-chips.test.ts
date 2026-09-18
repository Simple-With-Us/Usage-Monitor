import { describe, expect, it } from "vitest";
import { AGENT_WINDOW_CHIPS } from "../agent-window-chips";

describe("AGENT_WINDOW_CHIPS", () => {
  it("no longer exposes the odd 5h/24h/7d/All lookback strip", () => {
    expect(AGENT_WINDOW_CHIPS.map((chip) => chip.id)).toEqual(["30d"]);
    expect(AGENT_WINDOW_CHIPS.map((chip) => chip.label)).toEqual(["30d"]);
  });
});
