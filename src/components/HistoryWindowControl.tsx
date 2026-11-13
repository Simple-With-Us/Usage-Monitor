"use client";

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type TimeframeOption,
  currentMonthToken,
  generateMonthOptions,
  generateYearOptions,
  historyRangeLabel,
  isCurrentCalendarMonth,
  isPrimaryHistoryChip,
  timeframeShortLabel,
} from "@/hooks/useDashboardData";

/** Primary rail: This month + 30d (1m) / 90d (3m) / 180d (6m) / 12m (365d). */
const QUICK: Array<{ value: TimeframeOption; short: string; full: string }> = [
  {
    value: "month:current" as TimeframeOption,
    short: "This month",
    full: "This calendar month (UTC)",
  },
  { value: "30d", short: "30d", full: "Past 30 days (1 month)" },
  { value: "90d", short: "90d", full: "Past 90 days (3 months)" },
  { value: "180d", short: "180d", full: "Past 180 days (6 months)" },
  { value: "365d", short: "12m", full: "Past 12 months (1 year)" },
];

const MORE_ROLLING: Array<{ value: TimeframeOption; label: string }> = [
  { value: "1d", label: "Past 24 hours" },
  { value: "7d", label: "Past 7 days" },
  { value: "30d", label: "Past 30 days (1 month)" },
  { value: "90d", label: "Past 90 days (3 months)" },
  { value: "180d", label: "Past 180 days (6 months)" },
  { value: "365d", label: "Past 12 months (1 year)" },
  { value: "all", label: "All time" },
];

type Props = {
  value: TimeframeOption;
  onChange: (next: TimeframeOption) => void;
  className?: string;
};

function MenuSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-1">
      <p className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </p>
      {children}
    </div>
  );
}

function MenuItem({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
        selected
          ? "bg-accent-soft font-medium text-gray-900 dark:text-gray-100"
          : "text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800"
      }`}
    >
      <span className="truncate">{label}</span>
      {selected && (
        <span className="ml-2 text-accent" aria-hidden="true">
          ✓
        </span>
      )}
    </button>
  );
}

/**
 * Chart/telemetry history range control.
 *
 * Primary: This month · 7d · 30d · 90d. More: 24h, 180d, all, calendar months/years.
 * Does not affect MTD budget math — only charts, burn series, and usage-event lists.
 */
export default function HistoryWindowControl({ value, onChange, className = "" }: Props) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const labelId = useId();
  const monthOptions = useMemo(() => generateMonthOptions(13), []);
  const yearOptions = useMemo(() => generateYearOptions(3), []);

  const moreActive = !isPrimaryHistoryChip(value);
  const currentMonth = currentMonthToken();

  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  function select(next: TimeframeOption) {
    const resolved = (next as string) === "month:current" ? currentMonth : next;
    onChange(resolved);
    setMenuOpen(false);
  }

  return (
    <div ref={rootRef} className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span id={labelId} className="text-xs font-semibold text-gray-700 dark:text-gray-200">
          Chart range
        </span>
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Charts &amp; usage history only · budgets stay month-to-date
        </span>
      </div>

      <div
        role="group"
        aria-labelledby={labelId}
        className="inline-flex max-w-full items-stretch rounded-xl border border-gray-200 bg-gray-100/90 p-1 shadow-sm dark:border-gray-700 dark:bg-gray-800/90"
      >
        {QUICK.map((q) => {
          const token = (q.value as string) === "month:current" ? currentMonth : q.value;
          const active =
            (q.value as string) === "month:current"
              ? isCurrentCalendarMonth(value)
              : value === q.value;
          return (
            <button
              key={q.short}
              type="button"
              aria-pressed={active}
              title={q.full}
              onClick={() => select(token)}
              className={`min-h-10 shrink-0 rounded-lg px-2.5 text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:px-3 sm:text-sm ${
                active
                  ? "bg-accent text-white shadow-sm"
                  : "text-gray-600 hover:bg-white/90 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-900/70 dark:hover:text-gray-100"
              }`}
            >
              {q.short}
            </button>
          );
        })}

        <div className="relative shrink-0">
          <button
            type="button"
            aria-expanded={menuOpen}
            aria-haspopup="listbox"
            aria-pressed={moreActive}
            title="More history ranges"
            onClick={() => setMenuOpen((open) => !open)}
            className={`flex min-h-10 max-w-[9.5rem] items-center gap-1 rounded-lg px-2.5 text-xs font-semibold transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent sm:max-w-[11rem] sm:px-3 sm:text-sm ${
              moreActive
                ? "bg-accent text-white shadow-sm"
                : "text-gray-600 hover:bg-white/90 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-900/70 dark:hover:text-gray-100"
            }`}
          >
            <span className="truncate">{moreActive ? timeframeShortLabel(value) : "More"}</span>
            <svg
              className="h-3.5 w-3.5 shrink-0 opacity-80"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {menuOpen && (
            <div
              role="listbox"
              aria-label="More chart ranges"
              className="absolute right-0 top-full z-50 mt-1.5 max-h-72 w-56 overflow-y-auto rounded-xl border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
            >
              <MenuSection label="Rolling">
                {MORE_ROLLING.map((item) => (
                  <MenuItem
                    key={item.value}
                    label={item.label}
                    selected={value === item.value}
                    onSelect={() => select(item.value)}
                  />
                ))}
              </MenuSection>
              <div className="mx-2 border-t border-gray-100 dark:border-gray-800" />
              <MenuSection label="Calendar months">
                {monthOptions.map(({ token, label }) => (
                  <MenuItem
                    key={token as string}
                    label={token === currentMonth ? `${label} (this month)` : label}
                    selected={value === token}
                    onSelect={() => select(token)}
                  />
                ))}
              </MenuSection>
              <div className="mx-2 border-t border-gray-100 dark:border-gray-800" />
              <MenuSection label="Calendar years">
                {yearOptions.map(({ token, label }) => (
                  <MenuItem
                    key={token as string}
                    label={label}
                    selected={value === token}
                    onSelect={() => select(token)}
                  />
                ))}
              </MenuSection>
            </div>
          )}
        </div>
      </div>

      <p className="sr-only" aria-live="polite">
        Chart range set to {historyRangeLabel(value)}. Budget figures unchanged.
      </p>
    </div>
  );
}
