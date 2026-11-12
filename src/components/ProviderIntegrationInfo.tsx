"use client";

import dynamic from "next/dynamic";
import { useCallback, useRef, useState } from "react";
import type { ProviderIntegrationInstanceState } from "@/components/ProviderIntegrationDrawer";

const ProviderIntegrationDrawer = dynamic(
  () => import("@/components/ProviderIntegrationDrawer"),
  { ssr: false }
);

interface ProviderIntegrationInfoProps {
  providerName: string;
  providerType?: string;
  displayName: string;
  variant?: "icon" | "name" | "button";
  className?: string;
  instanceState?: ProviderIntegrationInstanceState;
}

export function publicConfigFieldNames(
  config: Record<string, unknown> | null | undefined,
  prefix = ""
): string[] {
  if (!config) return [];
  return Object.entries(config).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = publicConfigFieldNames(value as Record<string, unknown>, path);
      return nested.length > 0 ? nested : [path];
    }
    return [path];
  }).sort();
}

function InfoIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      className="h-4 w-4"
    >
      <circle cx="12" cy="12" r="9" strokeWidth="1.8" />
      <path d="M12 10.8v5.2" strokeWidth="1.8" strokeLinecap="round" />
      <circle cx="12" cy="7.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function ProviderIntegrationInfo({
  providerName,
  providerType,
  displayName,
  variant = "icon",
  className = "",
  instanceState,
}: ProviderIntegrationInfoProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  const label = `How ${displayName} integrates with this app`;
  const variantClass =
    variant === "icon"
      ? "relative z-10 inline-flex h-8 w-8 items-center justify-center rounded-lg text-gray-400 hover:bg-gray-100 hover:text-blue-700 dark:text-gray-500 dark:hover:bg-gray-700 dark:hover:text-blue-300"
      : variant === "name"
        ? "inline-flex items-center gap-1.5 text-left font-medium text-gray-900 hover:text-blue-700 dark:text-gray-100 dark:hover:text-blue-300"
        : "inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 hover:text-blue-700 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700 dark:hover:text-blue-300";

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        onClick={() => setOpen(true)}
        className={`${variantClass} focus:outline-none focus:ring-2 focus:ring-blue-500 ${className}`}
      >
        {variant === "name" ? <span>{displayName}</span> : null}
        {variant === "button" ? <span>Integration details</span> : null}
        <InfoIcon />
      </button>
      {open ? (
        <ProviderIntegrationDrawer
          providerName={providerName}
          providerType={providerType}
          displayName={displayName}
          instanceState={instanceState}
          onClose={close}
        />
      ) : null}
    </>
  );
}
