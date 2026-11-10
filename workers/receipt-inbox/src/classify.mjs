/**
 * Bounded receipt classification for the inbox Worker and bills calendar.
 * Never persist card numbers, raw MIME, or mailbox local-parts.
 */

export const RECEIPT_KINDS = ["subscription", "prepaid", "usage", "one_time"];
export const CALENDAR_SORTS = ["subscription", "prepaid", "usage", "dev-expense"];

const CARD = /\b(?:\d[ -]*?){13,19}\b/g;
// Bounded quantifiers: unbounded \S+ is quadratic on long dotted tokens from a public MX.
const EMAIL = /\b\S{1,254}@\S{1,254}\b/g;
const MAX_SUBJECT_SCAN_CHARS = 1024;
const MAX_TEXT_SCAN_CHARS = 8000;
const AMOUNT = /(?:USD|US\$|\$)\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/gi;

const CANCELLED_NO_RENEW = [
  { service: "FMP", match: /financial modeling prep|\bfmp\b/i },
  { service: "Massive", match: /\bmassive\b|polygon\.io/i },
];

const DOMAIN_HINT = /namecheap|unstoppable|porkbun|godaddy|registrar|domain registered|order summary/i;
const DEV_MEMBERSHIP = /apple developer|membership has been renewed/i;

export function redactSecrets(value) {
  if (typeof value !== "string") return "";
  return value.replace(CARD, "[card]").replace(EMAIL, "[email]");
}

export function boundedSubject(value, max = 180) {
  const cleaned = redactSecrets(String(value || "").slice(0, MAX_SUBJECT_SCAN_CHARS))
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.slice(0, max);
}

export function extractAmountUsd(text) {
  if (typeof text !== "string" || !text) return null;
  const candidates = [];
  for (const match of text.matchAll(AMOUNT)) {
    const n = Number(String(match[1]).replace(/,/g, ""));
    if (!Number.isFinite(n) || n <= 0 || n > 5000) continue;
    const ctx = text.slice(Math.max(0, match.index - 48), match.index + 24).toLowerCase();
    let score = 0;
    if (/(total|amount paid|amount charged|charged|grand total|you paid|final cost)/.test(ctx)) score += 6;
    if (/(invoice amount|amount:)/.test(ctx)) score += 4;
    if (/\btax\b/.test(ctx) && !/total/.test(ctx)) score -= 3;
    candidates.push({ score, n });
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score || b.n - a.n);
  return candidates[0].n;
}

export function calendarTitle({ amountUsd, service, sort }) {
  const amount = Number.isFinite(amountUsd) ? `$${amountUsd.toFixed(2)}` : "$—";
  const name = String(service || "Unknown").replace(/\s+/g, " ").trim() || "Unknown";
  const kind = CALENDAR_SORTS.includes(sort) ? sort : "usage";
  return `${amount} - ${name} - ${kind}`;
}

function isoDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

export function addUtcMonth(isoDay) {
  const date = new Date(`${isoDay}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

function ignoreReason(subject) {
  const text = String(subject || "");
  if (/unsuccessful|couldn't process|could not process|declined|payment failed/i.test(text)) {
    return "failed_payment";
  }
  if (/are now being forwarded|app store connect:|completed processing|action needed:|has been approved for beta/i.test(text)) {
    return "not_a_receipt";
  }
  if (/^fwd:/i.test(text)) return "forward_copy";
  return null;
}

function guessService({ subject, senderDomain, text }) {
  const blob = `${subject}\n${senderDomain}\n${text}`.toLowerCase();
  if (DOMAIN_HINT.test(blob) || DEV_MEMBERSHIP.test(blob)) {
    if (/namecheap/i.test(blob)) return "Namecheap";
    if (/unstoppable/i.test(blob)) return "Unstoppable Domains";
    if (/cloudflare/i.test(blob) && /domain/i.test(blob)) return "Cloudflare";
    if (DEV_MEMBERSHIP.test(blob)) return "Apple";
  }
  if (/openrouter/i.test(blob)) return "OpenRouter";
  if (/anthropic|claude/i.test(blob)) return "Anthropic";
  if (/mistral/i.test(blob)) return "Mistral";
  if (/twilio/i.test(blob)) return "Twilio";
  if (/hetzner/i.test(blob)) return "Hetzner";
  if (/github/i.test(blob)) return "GitHub";
  if (/\bxai\b|spacexai|grok/i.test(blob)) return "xAI";
  if (/openai|chatgpt/i.test(blob)) return "OpenAI";
  if (/pushover/i.test(blob)) return "Pushover";
  if (/quiver/i.test(blob)) return "Quiver";
  if (/roic\.ai|roic/i.test(blob)) return "roic.ai";
  if (/financial modeling prep|\bfmp\b/i.test(blob)) return "FMP";
  if (/\bmassive\b/i.test(blob)) return "Massive";
  if (/cloudflare/i.test(blob)) return "Cloudflare";
  const domain = String(senderDomain || "").split(".").slice(-2).join(".");
  return domain || "Unknown";
}

function guessKind({ subject, text, service }) {
  const blob = `${subject}\n${text}`;
  if (DOMAIN_HINT.test(blob) || DEV_MEMBERSHIP.test(blob)) {
    return { kind: "one_time", calendarSort: "dev-expense" };
  }
  if (/credit purchase|prepaid|account has been funded|account has been recharged|api credits/i.test(blob)) {
    return { kind: "prepaid", calendarSort: "prepaid" };
  }
  if (/actions usage|api invoice for|usage:|invoice for 0\d\/|bandwidth/i.test(blob)) {
    return { kind: "usage", calendarSort: "usage" };
  }
  if (/subscription|renews |monthly|annual|max 20x|claude pro|chatgpt plus|supergrok|copilot|developer plan/i.test(blob)) {
    return { kind: "subscription", calendarSort: "subscription" };
  }
  if (service === "Twilio" || service === "OpenRouter" || service === "Mistral" || service === "Hetzner") {
    return { kind: "usage", calendarSort: "usage" };
  }
  return { kind: "one_time", calendarSort: "usage" };
}

/**
 * Deterministic classification.  Usage invoices that arrive after the usage
 * window are filed on the received date; due date is recorded separately.
 * FMP/Massive file a historical paid receipt but never a next due date.
 */
export function classifyReceipt({
  subject,
  text = "",
  senderDomain = "",
  receivedAt,
  dueDate = null,
} = {}) {
  const cleanSubject = boundedSubject(subject);
  // Cap before the regexes run.  cleanText is never persisted or sent to an LLM.
  const cleanText = redactSecrets(String(text || "").slice(0, MAX_TEXT_SCAN_CHARS));
  const ignore = ignoreReason(cleanSubject);
  const receivedDate = isoDate(receivedAt) || isoDate(new Date());
  const due = isoDate(dueDate);
  if (ignore) {
    return {
      action: "ignore",
      reason: ignore,
      service: guessService({ subject: cleanSubject, senderDomain, text: cleanText }),
      kind: "one_time",
      calendarSort: "usage",
      amountUsd: null,
      expenseDate: receivedDate,
      dueDate: due,
      nextDueDate: null,
      cancelledNoRenew: false,
      label: cleanSubject || "Ignored receipt",
      notes: ignore,
    };
  }

  const service = guessService({ subject: cleanSubject, senderDomain, text: cleanText });
  const cancelled = CANCELLED_NO_RENEW.find((row) => row.match.test(`${cleanSubject} ${cleanText} ${service}`));
  const { kind, calendarSort } = guessKind({ subject: cleanSubject, text: cleanText, service });
  const amountUsd = extractAmountUsd(`${cleanSubject}\n${cleanText}`);
  const usagePostdated = kind === "usage";
  const expenseDate = usagePostdated ? receivedDate : (due || receivedDate);
  return {
    action: "file",
    reason: cancelled ? "cancelled_no_renew" : null,
    service,
    kind,
    calendarSort: calendarSort,
    amountUsd,
    expenseDate,
    dueDate: due,
    nextDueDate: cancelled || kind !== "subscription" ? null : addUtcMonth(expenseDate),
    cancelledNoRenew: Boolean(cancelled),
    label: cleanSubject || `${service} receipt`,
    notes: [
      due && due !== expenseDate ? `Due ${due}.` : null,
      cancelled ? `${cancelled.service} was cancelled via a temporary card and is not due again.` : null,
      usagePostdated ? "Usage invoice filed on the date received." : null,
    ].filter(Boolean).join(" "),
  };
}

export function llmSystemPrompt() {
  return [
    "Classify a vendor receipt for an owner expense ledger and Apple Calendar.",
    "Return JSON only with keys: action (file|ignore), service, kind (subscription|prepaid|usage|one_time),",
    "calendarSort (subscription|prepaid|usage|dev-expense), amountUsd (number|null), expenseDate (YYYY-MM-DD),",
    "dueDate (YYYY-MM-DD|null), nextDueDate (YYYY-MM-DD|null), cancelledNoRenew (boolean), label, notes, reason.",
    "File expenses on the due date unless the subscription was cancelled and is not due.",
    "FMP and Massive were cancelled with a temporary card and must not get a next due date.",
    "Usage invoices that are postdated file on the date received; still record dueDate when present.",
    "Domain renewals and Apple Developer membership are calendarSort dev-expense even if the domain is semi-unrelated.",
    "Ignore failed payments, App Store Connect processing mail, and forwarded copies.",
    "Never echo card numbers or email addresses.",
  ].join(" ");
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function asIsoDay(value) {
  return typeof value === "string" && ISO_DAY.test(value) ? value : null;
}

function asAmount(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 && n <= 5000 ? n : null;
}

export function mergeLlmClassification(base, parsed) {
  if (!parsed || typeof parsed !== "object") return null;
  const action = parsed.action === "ignore" || parsed.action === "file" ? parsed.action : base.action;
  const kind = RECEIPT_KINDS.includes(parsed.kind) ? parsed.kind : base.kind;
  const calendarSort = CALENDAR_SORTS.includes(parsed.calendarSort) ? parsed.calendarSort : base.calendarSort;
  const cancelledNoRenew = parsed.cancelledNoRenew === true || base.cancelledNoRenew === true;
  const expenseDate = asIsoDay(parsed.expenseDate) || base.expenseDate;
  const dueDate = asIsoDay(parsed.dueDate) ?? base.dueDate;
  let nextDueDate = asIsoDay(parsed.nextDueDate);
  if (cancelledNoRenew || kind !== "subscription") nextDueDate = null;
  else if (!nextDueDate) nextDueDate = addUtcMonth(expenseDate);
  return {
    ...base,
    action,
    reason: typeof parsed.reason === "string" ? redactSecrets(parsed.reason).slice(0, 180) : base.reason,
    service: typeof parsed.service === "string" && parsed.service.trim()
      ? redactSecrets(parsed.service).slice(0, 80)
      : base.service,
    kind,
    calendarSort,
    amountUsd: asAmount(parsed.amountUsd) ?? base.amountUsd,
    expenseDate,
    dueDate,
    nextDueDate,
    cancelledNoRenew,
    label: typeof parsed.label === "string" && parsed.label.trim()
      ? boundedSubject(parsed.label)
      : base.label,
    notes: typeof parsed.notes === "string" ? redactSecrets(parsed.notes).slice(0, 400) : base.notes,
  };
}

function chatCompletionsUrl(source) {
  if (source === "grok") return "https://api.x.ai/v1/chat/completions";
  if (source === "deepseek") return "https://api.deepseek.com/chat/completions";
  return null;
}

function chatModel(source) {
  if (source === "grok") return "grok-4-fast-non-reasoning";
  if (source === "deepseek") return "deepseek-chat";
  return null;
}

async function requestChatJson({ source, apiKey, userText, fetchImpl, timeoutMs }) {
  const url = chatCompletionsUrl(source);
  const model = chatModel(source);
  if (!url || !model || typeof apiKey !== "string" || apiKey.length < 20) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 400,
        messages: [
          { role: "system", content: llmSystemPrompt() },
          { role: "user", content: userText },
        ],
      }),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const content = body?.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    const start = content.indexOf("{");
    const end = content.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    return JSON.parse(content.slice(start, end + 1));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Rules first, then Grok, then DeepSeek.  Result is review metadata only.
 */
export async function enrichClassification(base, env, fetchImpl = globalThis.fetch, timeoutMs = 3500) {
  const userText = JSON.stringify({
    subject: base.label,
    serviceGuess: base.service,
    rules: base,
  }).slice(0, 6000);
  const attempts = [
    { source: "grok", apiKey: env?.XAI_API_KEY },
    { source: "deepseek", apiKey: env?.DEEPSEEK_API_KEY },
  ];
  for (const attempt of attempts) {
    const parsed = await requestChatJson({
      source: attempt.source,
      apiKey: attempt.apiKey,
      userText,
      fetchImpl,
      timeoutMs,
    });
    const merged = mergeLlmClassification(base, parsed);
    if (merged) return { review: merged, classificationSource: attempt.source };
  }
  return { review: base, classificationSource: "rules" };
}
