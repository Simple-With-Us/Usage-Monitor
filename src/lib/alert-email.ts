export const ALERT_EMAIL_SENT_BY = "(sent by Usage Monitor)";

/** Resend HTML body.  Footer names the sending app so a shared From address cannot hide it. */
export function formatAlertEmailHtml(input: {
  providerLabel: string;
  severity: string;
  message: string;
  detectedAtIso: string;
}): string {
  return `
          <h2>Usage Monitor Alert</h2>
          <p><strong>Provider:</strong> ${input.providerLabel}</p>
          <p><strong>Severity:</strong> ${input.severity}</p>
          <p><strong>Message:</strong> ${input.message}</p>
          <p><strong>Detected At:</strong> ${input.detectedAtIso}</p>
          <p>${ALERT_EMAIL_SENT_BY}</p>
        `;
}
