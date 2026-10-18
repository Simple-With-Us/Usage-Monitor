// OTLP logs/traces fixtures built from the real attribute names Claude Code
// and Codex emit (see src/lib/otlp/ai-request-mapper.ts for the sources).

type Attr = { key: string; value: Record<string, unknown> };

const s = (key: string, value: string): Attr => ({ key, value: { stringValue: value } });
const i = (key: string, value: number): Attr => ({ key, value: { intValue: String(value) } });
const d = (key: string, value: number): Attr => ({ key, value: { doubleValue: value } });

export const CLAUDE_REQUEST_ID = "req_011CUM1590abcdef";

export function claudeLogsPayload(overrides: { requestId?: string; timestamp?: string } = {}) {
  const timestamp = overrides.timestamp ?? "2026-10-17T15:04:05.123Z";
  return {
    resourceLogs: [
      {
        resource: {
          attributes: [
            s("service.name", "claude-code"),
            s("service.version", "2.9.0"),
            s("seat", "CLAUDE"),
            s("billing.mode", "subscription"),
          ],
        },
        scopeLogs: [
          {
            scope: { name: "com.anthropic.claude_code.events", version: "2.9.0" },
            logRecords: [
              {
                timeUnixNano: "1792249445123000000",
                body: { stringValue: "claude_code.user_prompt" },
                attributes: [
                  s("event.name", "user_prompt"),
                  s("prompt", "secret prompt text that must never be stored"),
                  s("session.id", "sess-1590"),
                ],
              },
              {
                timeUnixNano: "1792249445123000000",
                body: { stringValue: "claude_code.api_request" },
                attributes: [
                  s("event.name", "api_request"),
                  s("event.timestamp", timestamp),
                  i("event.sequence", 42),
                  s("session.id", "sess-1590"),
                  s("prompt.id", "prompt-7"),
                  s("user.email", "someone@example.com"),
                  s("organization.id", "org-1"),
                  s("terminal.type", "vscode"),
                  {
                    key: "workspace.host_paths",
                    value: {
                      arrayValue: {
                        values: [{ stringValue: "/Users/jay/apps/lanes/Usage-Monitor/claude-per-request-telemetry" }],
                      },
                    },
                  },
                  s("model", "claude-opus-5-5"),
                  d("cost_usd", 0.0421),
                  i("cost_usd_micros", 42100),
                  i("duration_ms", 8123),
                  i("input_tokens", 12),
                  i("output_tokens", 640),
                  i("cache_read_tokens", 88000),
                  i("cache_creation_tokens", 1500),
                  s("request_id", overrides.requestId ?? CLAUDE_REQUEST_ID),
                  s("client_request_id", "c0ffee00-1590"),
                  s("speed", "normal"),
                  s("query_source", "repl_main_thread"),
                  s("effort", "high"),
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

export function claudeLlmRequestSpanPayload(requestId = CLAUDE_REQUEST_ID) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [s("service.name", "claude-code"), s("seat", "CLAUDE")] },
        scopeSpans: [
          {
            spans: [
              {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: "b7ad6b7169203331",
                name: "claude_code.llm_request",
                startTimeUnixNano: "1792249436999000000",
                endTimeUnixNano: "1792249445122000000",
                attributes: [
                  s("model", "claude-opus-5-5"),
                  s("gen_ai.system", "anthropic"),
                  s("gen_ai.request.model", "claude-opus-5-5"),
                  s("session.id", "sess-1590"),
                  i("duration_ms", 8123),
                  i("ttft_ms", 1350),
                  i("input_tokens", 12),
                  i("output_tokens", 640),
                  i("cache_read_tokens", 88000),
                  i("cache_creation_tokens", 1500),
                  s("request_id", requestId),
                  { key: "success", value: { boolValue: true } },
                  i("status_code", 200),
                ],
              },
              {
                traceId: "0af7651916cd43dd8448eb211c80319c",
                spanId: "c7ad6b7169203332",
                name: "claude_code.tool",
                startTimeUnixNano: "1792249445200000000",
                endTimeUnixNano: "1792249445300000000",
                attributes: [s("tool_name", "Bash"), s("session.id", "sess-1590"), i("duration_ms", 100)],
              },
            ],
          },
        ],
      },
    ],
  };
}

const codexCommon = (timestamp: string) => [
  s("event.timestamp", timestamp),
  s("conversation.id", "conv-codex-1590"),
  s("app.version", "0.130.0"),
  s("auth_mode", "Chatgpt"),
  s("originator", "codex_cli_rs"),
  s("user.email", "someone@example.com"),
  s("terminal.type", "iTerm.app"),
  s("model", "gpt-6.1-sol"),
  s("slug", "gpt-6.1-sol"),
];

function codexPayload(records: Array<{ attributes: Attr[] }>) {
  return {
    resourceLogs: [
      {
        resource: { attributes: [s("service.name", "codex_cli_rs"), s("deployment.environment", "codex")] },
        scopeLogs: [{ scope: { name: "codex_otel" }, logRecords: records }],
      },
    ],
  };
}

export function codexApiRequestPayload() {
  return codexPayload([
    {
      attributes: [
        s("event.name", "codex.api_request"),
        i("duration_ms", 900),
        i("http.response.status_code", 200),
        i("attempt", 1),
        s("endpoint", "/responses"),
        ...codexCommon("2026-10-17T15:10:00.900Z"),
      ],
    },
    {
      attributes: [s("event.name", "codex.user_prompt"), i("prompt_length", 40), ...codexCommon("2026-10-17T15:09:59.000Z")],
    },
  ]);
}

export function codexCompletionPayload() {
  return codexPayload([
    {
      attributes: [
        s("event.name", "codex.sse_event"),
        s("event.kind", "response.output_text.delta"),
        i("duration_ms", 3),
        ...codexCommon("2026-10-17T15:10:01.500Z"),
      ],
    },
    {
      attributes: [
        s("event.name", "codex.sse_event"),
        s("event.kind", "response.completed"),
        i("input_token_count", 50000),
        i("output_token_count", 1200),
        i("cached_token_count", 45000),
        i("reasoning_token_count", 300),
        i("tool_token_count", 51200),
        i("ttft_ms", 1400),
        s("model_reasoning_effort", "high"),
        ...codexCommon("2026-10-17T15:10:06.000Z"),
      ],
    },
  ]);
}
