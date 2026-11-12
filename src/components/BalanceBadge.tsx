import { formatCurrency, NULL_DISPLAY } from "@/lib/format";

export default function BalanceBadge({
  amount,
  className = "",
}: {
  amount: number | null;
  className?: string;
}) {
  if (amount == null) {
    return (
      <span className={`text-sm text-gray-500 dark:text-gray-400 ${className}`}>{NULL_DISPLAY}</span>
    );
  }

  const isPositive = amount >= 0;
  const formatted = formatCurrency(Math.abs(amount), { minimumFractionDigits: 2 });

  return (
    <span
      className={`inline-flex items-center text-sm font-medium ${
        isPositive
          ? "text-emerald-600 dark:text-emerald-300"
          : "text-red-600 dark:text-red-300"
      } ${className}`}
    >
      {isPositive ? formatted : `-${formatted}`}
    </span>
  );
}
