// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import InfisicalSettingsPanel from "../InfisicalSettingsPanel";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("Infisical connection recovery controls", () => {
  it("keeps project selection, full replacement and disable available after a load failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(new Response("unavailable", { status: 503 })).mockResolvedValueOnce(new Response('{"ok":true}'));
    vi.stubGlobal("fetch", fetchImpl);
    render(<InfisicalSettingsPanel />);
    await screen.findByText(/Could not load Infisical connections/);
    const select = screen.getByLabelText("Project Use") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    fireEvent.change(select, { target: { value: "shared" } });
    expect((screen.getByLabelText("Infisical Project ID") as HTMLInputElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Verify And Save" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Disable Connection" }));
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledWith("/api/settings/infisical", expect.objectContaining({ method: "DELETE", body: '{"source":"shared"}' })));
    await screen.findByText(/Connection disabled; environment credentials/);
  });

  it("shows per-source recovery guidance while retaining healthy project metadata", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ connections: [{ source: "ct", projectId: "healthy-project", mode: "service-tokens", secretPath: "/", readPaths: ["/"], writePaths: [], tokens: [{ id: "read", paths: ["/"], permissions: ["read"], configured: true }] }], sourceErrors: [{ source: "um", error: "infisical_connection_unreadable" }], disabledSources: [] }))));
    render(<InfisicalSettingsPanel />);
    await screen.findByRole("alert");
    expect((screen.getByRole("button", { name: "Disable Connection" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Project Use"), { target: { value: "ct" } });
    expect((screen.getByLabelText("Infisical Project ID") as HTMLInputElement).value).toBe("healthy-project");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Project Use"), { target: { value: "um" } });
    expect(screen.getByRole("alert").textContent).toContain("Enter all credentials");
    expect((screen.getByLabelText("Service Token") as HTMLInputElement).disabled).toBe(false);
  });
});
