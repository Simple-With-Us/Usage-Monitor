import { describe, expect, it } from "vitest";
import { ALERT_EMAIL_SENT_BY, formatAlertEmailHtml } from "../alert-email";

describe("alert email sign-off", () => {
  it("ends the Resend HTML with (sent by Usage Monitor)", () => {
    const html = formatAlertEmailHtml({
      providerLabel: "Anthropic",
      severity: "warning",
      message: "balance is low",
      detectedAtIso: "2026-08-13T12:00:00.000Z",
    });
    expect(html).toContain("<h2>Usage Monitor Alert</h2>");
    expect(html).toContain("<p><strong>Provider:</strong> Anthropic</p>");
    expect(html).toContain("<p><strong>Message:</strong> balance is low</p>");
    expect(html).toContain(`<p>${ALERT_EMAIL_SENT_BY}</p>`);
    expect(html.trimEnd()).toMatch(/<p>\(sent by Usage Monitor\)<\/p>\s*$/);
  });
});
