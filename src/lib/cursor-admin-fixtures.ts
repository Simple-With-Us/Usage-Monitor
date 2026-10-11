// Doc fixtures for the Cursor Admin API poller.
//
// Shapes are copied from the published Admin API page fetched 2026-10-11:
// https://cursor.com/docs/account/teams/admin-api
// Endpoint: POST /teams/filtered-usage-events
// Auth overview (Basic, API key as the username, empty password):
// https://cursor.com/docs/api
//
// Do not invent fields.  Tests and the parser both start from these objects.

export const CURSOR_FILTERED_USAGE_EVENTS_FIXTURE = {
  totalUsageEventsCount: 113,
  pagination: {
    numPages: 5,
    currentPage: 1,
    pageSize: 25,
    hasNextPage: true,
    hasPreviousPage: false,
  },
  usageEvents: [
    {
      timestamp: "1750979225854",
      userEmail: "developer@company.com",
      conversationId: "8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b",
      model: "claude-4.5-sonnet",
      kind: "Usage-based",
      maxMode: true,
      requestsCosts: 5,
      isTokenBasedCall: true,
      isChargeable: true,
      isHeadless: false,
      tokenUsage: {
        inputTokens: 126,
        outputTokens: 450,
        cacheWriteTokens: 6112,
        cacheReadTokens: 11964,
        totalCents: 20.18232,
      },
      chargedCents: 21.36232,
      cursorTokenFee: 1.18,
    },
    {
      timestamp: "1750979173824",
      userEmail: "developer@company.com",
      conversationId: "8f2e4a1b-6c3d-4e5f-9a7b-2d1c8e6f4a3b",
      model: "claude-4.5-sonnet",
      kind: "Usage-based",
      maxMode: true,
      requestsCosts: 10,
      isTokenBasedCall: true,
      isChargeable: true,
      isHeadless: false,
      tokenUsage: {
        inputTokens: 5805,
        outputTokens: 311,
        cacheWriteTokens: 11964,
        cacheReadTokens: 0,
        totalCents: 40.167,
        discountPercentOff: 10,
      },
      chargedCents: 37.33,
      cursorTokenFee: 1.18,
    },
    {
      timestamp: "1750978339901",
      userEmail: "admin@company.com",
      model: "claude-4-sonnet-thinking",
      kind: "Included in Business",
      maxMode: true,
      requestsCosts: 1.4,
      isTokenBasedCall: false,
      isChargeable: false,
      isHeadless: false,
      chargedCents: 8,
    },
  ],
  period: {
    startDate: 1748411762359,
    endDate: 1751003762359,
  },
} as const;

/** Service-account example from the same docs page. */
export const CURSOR_SERVICE_ACCOUNT_USAGE_EVENT_FIXTURE = {
  timestamp: "1750979225854",
  userEmail: "agent-runner@company.com",
  serviceAccountId: "sa_abc123",
  serviceAccountName: "Nightly CI Agent",
  conversationId: "3b9d7c2e-1f4a-4b8c-a6d5-e9f0a2b4c6d8",
  model: "claude-4.5-sonnet",
  kind: "Usage-based",
  maxMode: true,
  requestsCosts: 5,
  isTokenBasedCall: true,
  isChargeable: true,
  isHeadless: true,
  tokenUsage: {
    inputTokens: 126,
    outputTokens: 450,
    cacheWriteTokens: 6112,
    cacheReadTokens: 11964,
    totalCents: 20.18232,
  },
  chargedCents: 21.36232,
  cursorTokenFee: 1.18,
} as const;

/** 429 body documented for the Admin API (`Retry-After: 60` is the header). */
export const CURSOR_ADMIN_RATE_LIMIT_BODY = {
  code: "error",
  message: "Rate limit exceeded",
} as const;
