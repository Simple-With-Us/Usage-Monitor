import { describe, expect, it } from "vitest";
import {
  ERROR_MAX_CHARS,
  PROMPT_RESPONSE_MAX_CHARS,
  mapDirectTurnsRequest,
  mapOtlpTracesRequest,
} from "../traces-mapper";

describe("mapOtlpTracesRequest", () => {
  it("maps a gen_ai span into an AgentTurn input", () => {
    const result = mapOtlpTracesRequest({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "agent.platform", value: { stringValue: "cursor-agent" } },
              { key: "seat", value: { stringValue: "cursor-cloud" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  name: "chat",
                  startTimeUnixNano: "1751500000000000000",
                  endTimeUnixNano: "1751500001500000000",
                  attributes: [
                    { key: "gen_ai.request.model", value: { stringValue: "gpt-5" } },
                    { key: "gen_ai.usage.input_tokens", value: { intValue: "100" } },
                    { key: "gen_ai.usage.output_tokens", value: { intValue: "40" } },
                    { key: "gen_ai.usage.cost", value: { doubleValue: 0.12 } },
                    { key: "gen_ai.conversation.id", value: { stringValue: "conv-1" } },
                    { key: "gen_ai.tool.name", value: { stringValue: "Read" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.ignored).toBe(0);
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0]).toMatchObject({
      platform: "cursor-agent",
      seat: "cursor-cloud",
      model: "gpt-5",
      inputTokens: 100,
      outputTokens: 40,
      costUsd: 0.12,
      conversationId: "conv-1",
      durationMs: 1500,
      toolCount: 1,
    });
    expect(result.turns[0].toolNames).toEqual(["Read"]);
  });

  it("ignores spans that are not agent turns", () => {
    const result = mapOtlpTracesRequest({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                {
                  name: "GET /api/health",
                  attributes: [{ key: "http.method", value: { stringValue: "GET" } }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.turns).toHaveLength(0);
    expect(result.ignored).toBe(1);
  });
});

describe("mapDirectTurnsRequest", () => {
  it("maps a relay { turns } payload and truncates prompt/response", () => {
    const result = mapDirectTurnsRequest({
      turns: [
        {
          platform: "cursor-agent",
          seat: "cloud",
          model: "gpt-5",
          inputTokens: 12,
          outputTokens: 8,
          conversationId: "c1",
          promptText: "x".repeat(PROMPT_RESPONSE_MAX_CHARS + 50),
          responseText: "y".repeat(PROMPT_RESPONSE_MAX_CHARS + 10),
          error: "z".repeat(ERROR_MAX_CHARS + 5),
          toolNames: ["Read", "Edit"],
          occurredAt: "2026-10-11T12:00:00.000Z",
        },
      ],
    });
    expect(result.ignored).toBe(0);
    expect(result.turns).toHaveLength(1);
    const turn = result.turns[0];
    expect(turn.platform).toBe("cursor-agent");
    expect(turn.promptText).toHaveLength(PROMPT_RESPONSE_MAX_CHARS);
    expect(turn.responseText).toHaveLength(PROMPT_RESPONSE_MAX_CHARS);
    expect(turn.error).toHaveLength(ERROR_MAX_CHARS);
    expect(turn.toolNames).toEqual(["Read", "Edit"]);
    expect(turn.toolCount).toBe(2);
    expect(turn.occurredAt.toISOString()).toBe("2026-10-11T12:00:00.000Z");
    expect(turn.contentExpiresAt).toBeInstanceOf(Date);
  });

  it("labels Claude Code trace turns with the harness, not the model vendor", () => {
    // Claude Code's spans carry gen_ai.system="anthropic" and name the harness
    // in the span prefix / service.name.  AgentTurn.platform must stay a
    // coding-platform value so a producer-scoped OTLP credential (producer
    // "claude-code") can write its own turns; labelling the turn "anthropic"
    // made the whole trace batch 403 at /api/otlp/v1/traces.
    const result = mapOtlpTracesRequest({
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: "service.name", value: { stringValue: "claude-code" } },
              { key: "seat", value: { stringValue: "CLAUDE" } },
            ],
          },
          scopeSpans: [
            {
              spans: [
                {
                  name: "claude_code.interaction",
                  startTimeUnixNano: "1751500000000000000",
                  endTimeUnixNano: "1751500002000000000",
                  attributes: [
                    { key: "gen_ai.system", value: { stringValue: "anthropic" } },
                    { key: "session.id", value: { stringValue: "sess-1" } },
                    { key: "model", value: { stringValue: "claude-opus-5-5" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.turns).toHaveLength(1);
    expect(result.turns[0].platform).toBe("claude-code");
    expect(result.turns[0].seat).toBe("CLAUDE");
    expect(result.turns[0].conversationId).toBe("sess-1");
  });

  it("keeps an explicit agent.platform over the Claude Code harness default", () => {
    const result = mapOtlpTracesRequest({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "service.name", value: { stringValue: "claude-code" } }],
          },
          scopeSpans: [
            {
              spans: [
                {
                  name: "claude_code.interaction",
                  startTimeUnixNano: "1751500000000000000",
                  endTimeUnixNano: "1751500001000000000",
                  attributes: [
                    { key: "agent.platform", value: { stringValue: "claude-code-desktop" } },
                    { key: "session.id", value: { stringValue: "sess-2" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(result.turns[0].platform).toBe("claude-code-desktop");
  });

  it("ignores malformed entries and caps the batch", () => {
    const result = mapDirectTurnsRequest({
      turns: [null, "nope", { platform: "cursor-agent", model: "gpt-5" }],
    });
    expect(result.turns).toHaveLength(1);
    expect(result.ignored).toBe(2);
  });
});
