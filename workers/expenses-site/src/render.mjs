/**
 * Server-rendered dashboard HTML for the expenses site.
 *
 * Light theme, no external assets, no emojis.  Copy follows the house style:
 * Title Case headings, sentence case values, two literal spaces between
 * sentences.  The table body is rendered server-side from D1 rows; a small
 * inline script handles the category filter and column sorting client-side.
 */
import { CATEGORIES, SIDES, categoryLabel, sideForCategory, sideLabel } from "./categories.mjs";

/** Escape text for HTML. */
export function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Format an ISO date as "Oct 5, 2026". */
export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/Chicago",
  });
}

/** Format a USD amount as "$1,234.56". */
export function formatAmount(usd) {
  return Number(usd).toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
  });
}

/**
 * @param {Array} expenses — D1 rows, newest first
 * @param {string} asOf — ISO timestamp of the last sync
 * @param {number} totalCount — expenses in the store (all time)
 */
export function renderDashboard(expenses, asOf, totalCount) {
  const present = [];
  for (const slug of Object.keys(CATEGORIES)) {
    // "personal" is covered by the side filter, not the subcategory list.
    if (slug === "personal") continue;
    if (slug === "other" || expenses.some((e) => e.category === slug)) {
      present.push(slug);
    }
  }
  // Subcategories after the two sides; "Other" last.
  present.sort((a, b) => {
    const rank = (s) => (s === "tech-ai" ? 10 : s === "other" ? 99 : 50);
    return rank(a) - rank(b);
  });

  const total = expenses.reduce((sum, e) => sum + Number(e.amount_usd || 0), 0);

  const rows = expenses
    .map(
      (e) => `      <tr data-category="${esc(e.category)}" data-side="${esc(
        sideForCategory(e.category)
      )}" data-amount="${esc(e.amount_usd)}" data-date="${esc(
        e.occurred_at
      )}" data-vendor="${esc(e.vendor).toLowerCase()}">
        <td data-sort="${esc(e.occurred_at)}">${esc(formatDate(e.occurred_at))}</td>
        <td>${esc(e.vendor)}</td>
        <td>${esc(e.label || "—")}</td>
        <td><span class="pill">${esc(categoryLabel(e.category))}</span></td>
        <td>${esc(e.kind.replace(/_/g, " "))}</td>
        <td class="num" data-sort="${esc(e.amount_usd)}">${esc(
        formatAmount(e.amount_usd)
      )}</td>
      </tr>`
    )
    .join("\n");

  // Filter bar: All, then the two sides, then the subcategories present.
  const sideFilters = Object.keys(SIDES).map((slug) => ({
    value: "side:" + slug,
    label: sideLabel(slug),
    primary: true,
  }));
  const filters = ["all", ...sideFilters.map((f) => f.value), ...present]
    .map((value) => {
      const isAll = value === "all";
      const isSide = value.startsWith("side:");
      const label = isAll
        ? "All"
        : isSide
          ? sideLabel(value.slice(5))
          : categoryLabel(value);
      const active = isAll ? ' aria-current="true"' : "";
      const primary = isAll || isSide;
      return `      <button class="filter${primary ? " primary" : ""}" data-filter="${esc(
        value
      )}"${active}>${esc(label)}</button>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Expenses</title>
<style>
  :root { color-scheme: light; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    background: #f7f7f5; color: #1a1a1a; margin: 0; padding: 2rem 1.5rem; }
  main { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 1.75rem; margin: 0 0 0.25rem; }
  .sub { color: #555; margin: 0 0 1.5rem; }
  .filters { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
  .filter { border: 1px solid #d4d4d0; background: #fff; border-radius: 999px;
    padding: 0.45rem 1rem; font-size: 0.9rem; cursor: pointer; }
  .filter.primary { font-weight: 600; }
  .filter[aria-current="true"] { background: #1a1a1a; color: #fff; border-color: #1a1a1a; }
  .summary { margin: 0 0 1rem; color: #333; }
  .summary strong { color: #111; }
  table { width: 100%; border-collapse: collapse; background: #fff;
    border: 1px solid #e2e2de; border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: 0.6rem 0.8rem; border-bottom: 1px solid #eee; }
  th { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em;
    color: #666; cursor: pointer; user-select: none; white-space: nowrap; }
  th .arrow { font-size: 0.7rem; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  th.num { text-align: right; }
  .pill { display: inline-block; background: #eef2f7; border-radius: 999px;
    padding: 0.15rem 0.6rem; font-size: 0.8rem; }
  .empty { padding: 2rem; text-align: center; color: #666; }
  footer { margin-top: 2rem; color: #888; font-size: 0.8rem; }
</style>
</head>
<body>
<main>
  <h1>Expenses</h1>
  <p class="sub">Last 6 months, rolling.  The ledger keeps every expense going back; this view shows the most recent half year.  Data syncs from spend tracking every 15 minutes.</p>
  <div class="filters" role="group" aria-label="Category filter">
${filters}
  </div>
  <p class="summary" id="summary"></p>
  <table aria-label="Expenses">
    <thead><tr>
      <th data-key="date">Date <span class="arrow"></span></th>
      <th data-key="vendor">Vendor <span class="arrow"></span></th>
      <th>Description</th>
      <th>Category</th>
      <th>Kind</th>
      <th class="num" data-key="amount">Amount <span class="arrow"></span></th>
    </tr></thead>
    <tbody id="rows">
${rows || '      <tr><td colspan="6" class="empty">No expenses in the last 6 months yet.</td></tr>'}
    </tbody>
  </table>
  <footer>Showing ${expenses.length} of ${totalCount} recorded expenses.  Last synced ${esc(
    asOf
  )}.</footer>
</main>
<script>
(function () {
  var rows = Array.prototype.slice.call(document.querySelectorAll("#rows tr[data-category]"));
  var summary = document.getElementById("summary");
  var activeFilter = "all";
  var sortKey = "date", sortDir = -1;

  function money(n) {
    return Number(n).toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function visible() {
    return rows.filter(function (r) {
      if (activeFilter === "all") return true;
      if (activeFilter.indexOf("side:") === 0) {
        return r.getAttribute("data-side") === activeFilter.slice(5);
      }
      return r.getAttribute("data-category") === activeFilter;
    });
  }

  function update() {
    var list = visible();
    var total = list.reduce(function (s, r) {
      return s + Number(r.getAttribute("data-amount") || 0);
    }, 0);
    list.forEach(function (r) { r.style.display = ""; });
    rows.forEach(function (r) {
      if (list.indexOf(r) === -1) r.style.display = "none";
    });
    // Re-append in sort order.
    var tbody = document.getElementById("rows");
    list.sort(function (a, b) {
      var va = a.getAttribute("data-" + sortKey) || "";
      var vb = b.getAttribute("data-" + sortKey) || "";
      var cmp = sortKey === "amount"
        ? Number(va) - Number(vb)
        : va < vb ? -1 : va > vb ? 1 : 0;
      return cmp * sortDir;
    }).forEach(function (r) { tbody.appendChild(r); });
    var label =
      activeFilter === "all"
        ? "all categories"
        : activeFilter.indexOf("side:") === 0
          ? activeFilter.slice(5)
          : activeFilter.replace(/-/g, " ");
    // textContent, not innerHTML: the label derives from our own filter
    // buttons, but there is no reason to parse HTML here at all.
    summary.textContent = "Showing " + list.length + " expenses in " +
      label + " · total " + money(total) + ".";
  }

  document.querySelectorAll(".filter").forEach(function (btn) {
    btn.addEventListener("click", function () {
      document.querySelectorAll(".filter").forEach(function (b) {
        b.removeAttribute("aria-current");
      });
      btn.setAttribute("aria-current", "true");
      activeFilter = btn.getAttribute("data-filter");
      update();
    });
  });

  document.querySelectorAll("th[data-key]").forEach(function (th) {
    th.addEventListener("click", function () {
      var key = th.getAttribute("data-key");
      if (sortKey === key) { sortDir *= -1; } else { sortKey = key; sortDir = key === "vendor" ? 1 : -1; }
      document.querySelectorAll("th .arrow").forEach(function (a) { a.textContent = ""; });
      th.querySelector(".arrow").textContent = sortDir === 1 ? "▲" : "▼";
      update();
    });
  });

  // Seed the summary and default date-descending order.
  document.querySelector('th[data-key="date"] .arrow').textContent = "▼";
  update();
})();
</script>
</body>
</html>`;
}
