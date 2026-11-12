import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  message: string;
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/**
 * Centered empty state — mirrors iOS DesignSystem.EmptyState for web parity.
 */
export default function EmptyState({
  title,
  message,
  icon,
  action,
  className = "",
}: EmptyStateProps) {
  return (
    <div
      className={`flex flex-col items-center justify-center px-6 py-12 text-center ${className}`}
      role="status"
    >
      {icon && (
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
          {icon}
        </div>
      )}
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{title}</h3>
      <p className="mt-2 max-w-sm text-sm text-gray-500 dark:text-gray-400">{message}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
