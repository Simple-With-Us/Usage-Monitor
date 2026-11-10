import { describe, expect, it } from "vitest";
import {
  addUtcMonth,
  boundedSubject,
  calendarTitle,
  classifyReceipt,
  extractAmountUsd,
  enrichClassification,
  mergeLlmClassification,
} from "./src/classify.mjs";

describe("pathological input guard", () => {
  // Hostile mail from the public MX.  These took 12 seconds or more before the caps.
  const dotted = "a.".repeat(100_000);

  it("caps the body before the redaction regexes run", () => {
    const started = performance.now();
    const review = classifyReceipt({ subject: "x", text: dotted, receivedAt: "2026-08-22T00:00:00.000Z" });
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(review.action).toBe("file");
  });

  it("caps the subject before the redaction regexes run", () => {
    const started = performance.now();
    expect(boundedSubject(dotted).length).toBeLessThanOrEqual(180);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("still redacts ordinary addresses and card numbers", () => {
    const subject = boundedSubject("Paid by person@example.com with 4242 4242 4242 4242");
    expect(subject).not.toContain("person@example.com");
    expect(subject).not.toContain("4242");
  });

  it("still finds an amount inside the first 8,000 characters and ignores one past it", () => {
    const receivedAt = "2026-08-22T00:00:00.000Z";
    expect(classifyReceipt({ subject: "x", text: "Total $19.99", receivedAt }).amountUsd).toBe(19.99);
    expect(classifyReceipt({ subject: "x", text: `${"y ".repeat(4_000)}Total $19.99`, receivedAt }).amountUsd).toBeNull();
  });
});

describe("boundedSubject", () => {
  it("strips emails and cards and truncates", () => {
    expect(boundedSubject("Receipt for billing@x.com visa 4111 1111 1111 1111")).toContain("[email]");
    expect(boundedSubject("Receipt for billing@x.com visa 4111 1111 1111 1111")).toContain("[card]");
    expect(boundedSubject("a".repeat(200)).length).toBe(180);
  });
});

describe("extractAmountUsd", () => {
  it("prefers an amount paid total over a tax line", () => {
    expect(extractAmountUsd("Tax $2.90 Total $31.90 Amount paid $31.90")).toBe(31.9);
  });
});

describe("calendarTitle", () => {
  it("uses price - service - sort", () => {
    expect(calendarTitle({ amountUsd: 200.01, service: "GitHub", sort: "usage" }))
      .toBe("$200.01 - GitHub - usage");
    expect(calendarTitle({ amountUsd: 14.98, service: "Namecheap", sort: "dev-expense" }))
      .toBe("$14.98 - Namecheap - dev-expense");
  });
});

describe("classifyReceipt", () => {
  it("ignores a failed payment", () => {
    const result = classifyReceipt({
      subject: "$5.33 payment to Cursor was unsuccessful",
      receivedAt: "2026-08-22T00:00:00.000Z",
    });
    expect(result.action).toBe("ignore");
    expect(result.reason).toBe("failed_payment");
  });

  it("files FMP historically and never schedules a next due date", () => {
    const result = classifyReceipt({
      subject: "Your receipt from Financial Modeling Prep #2240-0152",
      text: "Starter Access - Monthly Amount paid $31.90 Paid June 22, 2026",
      senderDomain: "stripe.com",
      receivedAt: "2026-06-22T18:00:00.000Z",
    });
    expect(result.action).toBe("file");
    expect(result.service).toBe("FMP");
    expect(result.cancelledNoRenew).toBe(true);
    expect(result.nextDueDate).toBeNull();
    expect(result.amountUsd).toBe(31.9);
  });

  it("treats domain renewals as a dev expense", () => {
    const result = classifyReceipt({
      subject: "Namecheap Order Summary (Order# 201400665);",
      text: "txadvocacy.com 1 year Final Cost : $14.98",
      senderDomain: "namecheap.com",
      receivedAt: "2026-05-03T12:00:00.000Z",
    });
    expect(result.calendarSort).toBe("dev-expense");
    expect(result.service).toBe("Namecheap");
    expect(result.amountUsd).toBe(14.98);
  });

  it("files postdated usage on the received date and keeps the due date", () => {
    const result = classifyReceipt({
      subject: "[GitHub] Payment Receipt for jaywedgeworth22",
      text: "GitHub Actions Usage: $184.05 USD Jul 1, 2026 - Jul 31, 2026 Total: $200.01 USD",
      senderDomain: "github.com",
      receivedAt: "2026-08-21T20:09:52.000Z",
      dueDate: "2026-08-28T00:00:00.000Z",
    });
    expect(result.kind).toBe("usage");
    expect(result.expenseDate).toBe("2026-08-21");
    expect(result.dueDate).toBe("2026-08-28");
    expect(result.notes).toMatch(/date received/i);
  });

  it("schedules next due for an active subscription", () => {
    const result = classifyReceipt({
      subject: "Your Claude Pro receipt",
      text: "Claude Pro monthly subscription Amount paid $20.00 renews",
      senderDomain: "anthropic.com",
      receivedAt: "2026-08-01T12:00:00.000Z",
    });
    expect(result.kind).toBe("subscription");
    expect(result.nextDueDate).toBe(addUtcMonth(result.expenseDate));
  });
});

describe("mergeLlmClassification", () => {
  it("clears next due when the model marks cancelledNoRenew", () => {
    const base = classifyReceipt({
      subject: "Your Claude Pro receipt",
      text: "Claude Pro monthly subscription Amount paid $20.00 renews",
      senderDomain: "anthropic.com",
      receivedAt: "2026-08-01T12:00:00.000Z",
    });
    const merged = mergeLlmClassification(base, { cancelledNoRenew: true, nextDueDate: "2026-09-01" });
    expect(merged.nextDueDate).toBeNull();
    expect(merged.cancelledNoRenew).toBe(true);
  });
});

describe("enrichClassification", () => {
  it("uses Grok then DeepSeek and never requires a ledger POST", async () => {
    const base = classifyReceipt({
      subject: "OpenAI invoice Amount paid $19.99",
      text: "Amount paid $19.99",
      senderDomain: "openai.com",
      receivedAt: "2026-08-22T00:00:00.000Z",
    });
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(String(url));
      if (String(url).includes("api.x.ai")) {
        return new Response("upstream failed", { status: 500 });
      }
      return Response.json({
        choices: [{
          message: {
            content: JSON.stringify({
              action: "file",
              service: "OpenAI",
              kind: "subscription",
              calendarSort: "subscription",
              amountUsd: 19.99,
              expenseDate: "2026-08-22",
              nextDueDate: "2026-09-22",
              cancelledNoRenew: false,
              label: "OpenAI ChatGPT Plus",
              notes: "LLM backup",
            }),
          },
        }],
      });
    };
    const result = await enrichClassification(base, {
      XAI_API_KEY: "x".repeat(32),
      DEEPSEEK_API_KEY: "d".repeat(32),
    }, fetchImpl);
    expect(urls[0]).toContain("api.x.ai");
    expect(urls[1]).toContain("api.deepseek.com");
    expect(result.classificationSource).toBe("deepseek");
    expect(result.review.service).toBe("OpenAI");
    expect(result.review.nextDueDate).toBe("2026-09-22");
  });

  it("stays on rules when no LLM keys are set", async () => {
    const base = classifyReceipt({
      subject: "OpenAI invoice Amount paid $19.99",
      receivedAt: "2026-08-22T00:00:00.000Z",
    });
    const result = await enrichClassification(base, {}, async () => {
      throw new Error("must not call the network");
    });
    expect(result.classificationSource).toBe("rules");
  });
});

