export type SortDirection = "asc" | "desc";

export default function SortHeader<F extends string>({
  field,
  label,
  className = "",
  align = "left",
  activeField,
  direction,
  onSort,
  paddingClassName = "px-6 py-3",
  labelClassName = "",
  title,
}: {
  field: F;
  label: string;
  className?: string;
  align?: "left" | "right";
  activeField: F;
  direction: SortDirection;
  onSort: (field: F) => void;
  paddingClassName?: string;
  labelClassName?: string;
  title?: string;
}) {
  const isActive = activeField === field;
  return (
    <th
      aria-sort={isActive ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className={`${paddingClassName} font-medium text-gray-500 dark:text-gray-400 ${labelClassName} ${className}`}
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        title={title}
        className={`group flex w-full items-center hover:text-gray-800 dark:hover:text-gray-100 ${
          align === "right" ? "justify-end text-right" : "justify-start text-left"
        }`}
      >
        {label}
        <span className={`ml-1 ${isActive ? "text-gray-500 dark:text-gray-300" : "text-gray-300 opacity-0 group-hover:opacity-100 group-focus:opacity-100 dark:text-gray-600"}`}>
          {isActive ? (direction === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </button>
    </th>
  );
}
