/**
 * @deprecated Coding Agents no longer exposes a lookback strip. Agent Bar
 * parity uses `/api/quota-windows` (FleetQuotaMatrixCard / SubscriptionQuotasCard).
 * Overview telemetry fetches a fixed `30d` window.
 *
 * Kept so older imports/tests compile; prefer deleting call sites instead of
 * adding new chips.
 */
export const AGENT_WINDOW_IDS = ["30d"] as const;
export type AgentWindowId = (typeof AGENT_WINDOW_IDS)[number];

export interface AgentWindowChip {
  id: AgentWindowId;
  label: string;
}

export const AGENT_WINDOW_CHIPS: readonly AgentWindowChip[] = [
  { id: "30d", label: "30d" },
];
