// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import FleetBudgetCard from "../FleetBudgetCard";
import { BUDGET_VIEW } from "@/lib/fleet-budget/__tests__/view-fixture";
const fetchMock = vi.fn();
beforeEach(() => { vi.stubGlobal("fetch", fetchMock); fetchMock.mockReset(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
const response = (value: unknown) => ({ ok: true, json: async () => value });

describe("FleetBudgetCard read-only monitor", () => {
  it("shows disabled admission with existing liability and honest MiniMax unknowns", async () => {
    fetchMock.mockResolvedValue(response(BUDGET_VIEW));
    render(<FleetBudgetCard />);
    expect(await screen.findByText("Not Activated")).toBeTruthy();
    expect(screen.getAllByText("$0.40")).toHaveLength(2);
    expect(screen.getByText("$1.50")).toBeTruthy();
    const mini = screen.getByText("MiniMax", { selector: "h3" }).parentElement!;
    expect(within(mini).getAllByText("Unknown")).toHaveLength(2);
    expect(within(mini).getByText("$0.05")).toBeTruthy();
    expect(screen.getAllByText(/Final costs for outstanding requests are unknown/, { exact: false })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: /enable|activate/i })).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/fleet-budget-status");
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ cache: "no-store" });
  });
  it("clears money figures on refresh failure and retries safely", async () => {
    fetchMock.mockResolvedValueOnce(response(BUDGET_VIEW)).mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce(response(BUDGET_VIEW));
    render(<FleetBudgetCard />);
    await screen.findByText("Not Activated");
    fireEvent.click(screen.getByRole("button", { name: "Refresh Budget" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("$1.50")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry Budget" }));
    expect(await screen.findByText("$1.50")).toBeTruthy();
  });
  it("rejects malformed money or provider responses instead of inventing zero", async () => {
    fetchMock.mockResolvedValue(response({ ...BUDGET_VIEW, snapshot: { ...BUDGET_VIEW.snapshot, settledPolicyMicros: "NaN" } }));
    render(<FleetBudgetCard />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });
  it("shows persistent blocked and paused states distinctly", async () => {
    fetchMock.mockResolvedValueOnce(response({ ...BUDGET_VIEW, enabled: true, snapshot: { ...BUDGET_VIEW.snapshot, blocked: true } }))
      .mockResolvedValueOnce(response({ ...BUDGET_VIEW, enabled: true }));
    render(<FleetBudgetCard />);
    expect(await screen.findByText("DeepSeek Blocked")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Budget" }));
    expect(await screen.findByText("Admission Paused")).toBeTruthy();
  });
  it("bounds hanging reads, clears figures and leaves a working retry path", async () => {
    vi.useFakeTimers();
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<FleetBudgetCard />);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Budget" })).toBeTruthy();
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    vi.useRealTimers();
    fetchMock.mockResolvedValue(response(BUDGET_VIEW));
    fireEvent.click(screen.getByRole("button", { name: "Retry Budget" }));
    expect(await screen.findByText("Not Activated")).toBeTruthy();
  });
  it("aborts unfinished reads on unmount and ignores late results", async () => {
    let resolve!: (r: unknown) => void;
    fetchMock.mockReturnValue(new Promise((r) => { resolve = r; }));
    const view = render(<FleetBudgetCard />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    view.unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => resolve(response(BUDGET_VIEW)));
    expect(screen.queryByText("Not Activated")).toBeNull();
  });
});
