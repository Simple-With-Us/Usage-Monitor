import path from "node:path";
import { test, expect } from "@playwright/test";

for (const viewport of [{ name: "desktop", width: 1280, height: 1000 }, { name: "mobile", width: 390, height: 844 }]) {
  test(`Infisical connection editor ${viewport.name}: modes, masked save and error state`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize(viewport);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const login = await page.request.post("/api/auth/login", { data: { password: process.env.E2E_TEST_PASSWORD } });
    expect(login.ok()).toBe(true);
    let rejectSave = false;
    let saved: Record<string, unknown> | null = null;
    await page.route("**/api/**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/settings/infisical") {
        if (route.request().method() === "PUT") {
          if (rejectSave) { await route.fulfill({ status: 400, json: { error: "Infisical connection could not be verified or saved" } }); return; }
          const body = route.request().postDataJSON();
          expect(body).not.toHaveProperty("clientIdConfigured");
          const { clientId: _id, clientSecret: _secret, tokens, ...metadata } = body;
          void _id; void _secret;
          saved = { ...metadata, clientIdConfigured: false, clientSecretConfigured: false, tokens: tokens.map(({ token: _token, ...entry }: { token?: string; id: string }) => { void _token; return { ...entry, configured: true }; }) };
          await route.fulfill({ json: { connection: saved } }); return;
        }
        if (route.request().method() === "DELETE") { saved = null; await route.fulfill({ json: { ok: true } }); return; }
        await route.fulfill({ json: { connections: saved ? [saved] : [] } }); return;
      }
      if (["/api/providers", "/api/projects", "/api/subscriptions"].includes(url.pathname)) { await route.fulfill({ json: [] }); return; }
      await route.fulfill({ json: {} });
    });
    await page.route(/^(https?:)?\/\/(?!127\.0\.0\.1|localhost).*/, (route) => route.abort());
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Infisical Connections", exact: true })).toBeVisible();
    const panel = page.getByRole("region", { name: "Infisical connections" });
    await expect(panel.getByRole("button", { name: "Verify And Save" })).toBeEnabled();
    await panel.getByRole("combobox", { name: "Authentication", exact: true }).selectOption("machine-identity");
    await expect(panel.getByLabel("Client ID", { exact: true })).toBeVisible();
    await expect(panel.getByLabel("Client Secret", { exact: true })).toHaveAttribute("type", "password");
    await panel.getByRole("combobox", { name: "Authentication", exact: true }).selectOption("service-tokens");
    await expect(panel.getByLabel("Client ID", { exact: true })).toHaveCount(0);
    await panel.getByLabel("Infisical Project ID", { exact: true }).fill("mock-project");
    await panel.getByLabel("Service Token", { exact: true }).fill("test-only-service-token");
    await panel.getByRole("button", { name: "Verify And Save" }).click();
    await expect(panel.getByRole("status")).toHaveText("Connection verified and saved");
    await expect(panel.getByLabel("Service Token", { exact: true })).toHaveValue("");
    await expect(panel.getByLabel("Service Token", { exact: true })).toHaveAttribute("placeholder", "Configured");
    rejectSave = true;
    await panel.getByRole("button", { name: "Verify And Save" }).click();
    await expect(panel.getByRole("status")).toHaveText("Connection could not be verified or saved");
    await expect(panel.getByText("test-only-service-token", { exact: true })).toHaveCount(0);
    await page.addStyleTag({ path: path.resolve("tests/e2e/visual-determinism.css") });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    if (process.env.UM_INFISICAL_SCREENSHOT_DIR) {
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: path.join(process.env.UM_INFISICAL_SCREENSHOT_DIR, `infisical-${viewport.name}.png`), fullPage: true, animations: "disabled", caret: "hide" });
    }
    await panel.getByRole("button", { name: "Disable Connection" }).click();
    await expect(panel.getByRole("status")).toContainText("Connection disabled");
  });
}
