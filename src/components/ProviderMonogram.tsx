/**
 * Letter monogram for provider rows — scan aid when logos aren't available.
 * Color is deterministic from the display name so families stay visually stable.
 */

const PALETTE = [
  "bg-indigo-100 text-indigo-700 dark:bg-indigo-950/60 dark:text-indigo-300",
  "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300",
  "bg-violet-100 text-violet-700 dark:bg-violet-950/60 dark:text-violet-300",
  "bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300",
  "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-200",
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
] as const;

function hashName(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i += 1) {
    h = (h * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function monogramLetter(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const ch = trimmed[0];
  return /[a-zA-Z0-9]/.test(ch) ? ch.toUpperCase() : "?";
}

export function monogramClass(name: string): string {
  return PALETTE[hashName(name) % PALETTE.length];
}

interface ProviderMonogramProps {
  name: string;
  size?: "sm" | "md";
  className?: string;
}

export default function ProviderMonogram({
  name,
  size = "sm",
  className = "",
}: ProviderMonogramProps) {
  const dim = size === "md" ? "h-10 w-10 text-sm" : "h-7 w-7 text-xs";
  return (
    <span
      aria-hidden="true"
      className={`inline-flex shrink-0 items-center justify-center rounded-lg font-semibold ${dim} ${monogramClass(name)} ${className}`}
    >
      {monogramLetter(name)}
    </span>
  );
}
