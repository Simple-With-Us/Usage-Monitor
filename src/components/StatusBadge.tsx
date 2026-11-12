import {
  statusBadgeClasses,
  type UiSemanticStatus,
} from "@/lib/ui-status";

interface StatusBadgeProps {
  label: string;
  status: UiSemanticStatus;
  className?: string;
}

/** Unified status chip used across Attention, workspace, Settings, and hero. */
export default function StatusBadge({ label, status, className = "" }: StatusBadgeProps) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadgeClasses(status)} ${className}`}
    >
      {label}
    </span>
  );
}
