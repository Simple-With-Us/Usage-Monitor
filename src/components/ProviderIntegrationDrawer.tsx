"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  getProviderIntegrationProfile,
  type BillingVisibility,
  type IntegrationMode,
} from "@/lib/provider-integration-catalog";

interface ProviderIntegrationDrawerProps {
  providerName: string;
  providerType?: string;
  displayName: string;
  instanceState?: ProviderIntegrationInstanceState;
  onClose: () => void;
}

export interface ProviderIntegrationInstanceState {
  isActive: boolean;
  primaryCredentialConfigured: boolean;
  keyPreview?: string | null;
  publicConfigFields: string[];
  protectedConfigFields: string[];
  protectedConfigReadable?: boolean;
  lastSnapshotAt?: string | null;
  externalBillingRecordCount: number;
  externalBillingSources: string[];
}

const MODE_LABELS: Record<IntegrationMode, string> = {
  direct: "Direct API",
  partial: "Partial API",
  "push-only": "Push / manual",
  manual: "Manual",
  "health-only": "Health only",
  configurable: "Custom endpoint",
};

const BILLING_LABELS: Record<BillingVisibility, string> = {
  actual: "Actual cost",
  partial: "Partial billing",
  metadata: "Plan / quota only",
  manual: "Manual billing",
  none: "No billing",
};

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function Section({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2 border-t border-gray-100 pt-5">
      <h3 className="text-sm font-semibold text-gray-900">{title}</h3>
      {children}
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <ul className="space-y-2 text-sm leading-6 text-gray-600">
      {items.map((item) => (
        <li key={item} className="flex gap-2">
          <span aria-hidden="true" className="mt-2 h-1.5 w-1.5 flex-none rounded-full bg-gray-300" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export default function ProviderIntegrationDrawer({
  providerName,
  providerType,
  displayName,
  instanceState,
  onClose,
}: ProviderIntegrationDrawerProps) {
  const profile = getProviderIntegrationProfile(providerName, providerType);
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const summaryId = useId();
  const keyLastFour = instanceState?.keyPreview?.slice(-4) ?? null;

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus();

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        // This drawer can be opened above AddProviderModal. Capture and stop
        // the underlying dialog's global focus/escape handler while active.
        event.stopImmediatePropagation();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;

      const focusable = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((element) => !element.hasAttribute("disabled"));
      if (focusable.length === 0) {
        event.preventDefault();
        panelRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose]);

  const content = (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-gray-950/40"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        aria-describedby={summaryId}
        tabIndex={-1}
        className="h-full w-full max-w-xl overflow-y-auto bg-white shadow-2xl outline-none"
      >
        <header className="sticky top-0 z-10 border-b border-gray-200 bg-white/95 px-5 py-4 backdrop-blur sm:px-7">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
                Integration details
              </p>
              <h2 id={headingId} className="mt-1 text-xl font-semibold text-gray-950">
                {displayName}
              </h2>
              <p className="mt-1 text-xs text-gray-500">
                {profile.displayName} adapter · {profile.category}
              </p>
            </div>
            <button
              ref={closeRef}
              type="button"
              onClick={onClose}
              aria-label={`Close ${displayName} integration details`}
              className="flex h-10 w-10 flex-none items-center justify-center rounded-lg border border-gray-200 text-xl text-gray-500 hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
        </header>

        <div className="space-y-5 px-5 py-6 sm:px-7">
          <div className="flex flex-wrap gap-2">
            <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">
              {MODE_LABELS[profile.mode]}
            </span>
            <span className="rounded-full bg-gray-100 px-2.5 py-1 text-xs font-semibold text-gray-700">
              {BILLING_LABELS[profile.billing.visibility]}
            </span>
            <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-semibold text-emerald-700">
              {profile.provenance.confidence} confidence
            </span>
          </div>

          <p id={summaryId} className="text-sm leading-6 text-gray-700">
            {profile.summary}
          </p>

          <div className="rounded-xl border border-blue-100 bg-blue-50 p-4 text-sm leading-6 text-blue-950">
            <p className="font-semibold">Account boundaries</p>
            <p className="mt-1">
              Each configured row keeps independent credentials and snapshots. Same-name rows do
              not auto-group or share keys. An explicit group ID is metadata only; it does not merge
              accounts. The dashboard does not aggregate provider account balances or credits.
              Project allocations share attribution percentages, not provider data.
            </p>
          </div>

          {instanceState ? (
            <Section title="Current configured state">
              <dl className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
                <div className="rounded-lg bg-gray-50 p-3">
                  <dt className="text-xs font-medium text-gray-500">Polling</dt>
                  <dd className="mt-1 font-medium text-gray-900">
                    {instanceState.isActive ? "Active" : "Inactive"}
                  </dd>
                </div>
                <div className="rounded-lg bg-gray-50 p-3">
                  <dt className="text-xs font-medium text-gray-500">Primary credential</dt>
                  <dd className="mt-1 font-medium text-gray-900">
                    {instanceState.primaryCredentialConfigured
                      ? keyLastFour
                        ? `Configured · •••• ${keyLastFour}`
                        : "Configured"
                      : "Not configured"}
                  </dd>
                </div>
                <div className="rounded-lg bg-gray-50 p-3 sm:col-span-2">
                  <dt className="text-xs font-medium text-gray-500">Public configuration fields</dt>
                  <dd className="mt-1 break-words text-gray-900">
                    {instanceState.publicConfigFields.length > 0
                      ? instanceState.publicConfigFields.join(", ")
                      : "None"}
                  </dd>
                </div>
                <div className="rounded-lg bg-gray-50 p-3 sm:col-span-2">
                  <dt className="text-xs font-medium text-gray-500">Protected configuration fields</dt>
                  <dd className="mt-1 break-words text-gray-900">
                    {instanceState.protectedConfigFields.length > 0
                      ? instanceState.protectedConfigFields.join(", ")
                      : "None"}
                    {instanceState.protectedConfigFields.length > 0 &&
                    instanceState.protectedConfigReadable === false
                      ? " · stored metadata is not currently readable"
                      : ""}
                  </dd>
                </div>
                <div className="rounded-lg bg-gray-50 p-3">
                  <dt className="text-xs font-medium text-gray-500">Latest snapshot</dt>
                  <dd className="mt-1 font-medium text-gray-900">
                    {instanceState.lastSnapshotAt
                      ? new Date(instanceState.lastSnapshotAt).toLocaleString()
                      : "None"}
                  </dd>
                </div>
                <div className="rounded-lg bg-gray-50 p-3">
                  <dt className="text-xs font-medium text-gray-500">Connected billing records</dt>
                  <dd className="mt-1 font-medium text-gray-900">
                    {instanceState.externalBillingRecordCount}
                    {instanceState.externalBillingSources.length > 0
                      ? ` · ${instanceState.externalBillingSources.join(", ")}`
                      : ""}
                  </dd>
                </div>
              </dl>
            </Section>
          ) : null}

          <Section title="What this app reads">
            <BulletList items={profile.reads} />
          </Section>

          <Section title="What is stored in this app">
            <BulletList items={profile.stores} />
          </Section>

          <Section title="What is shared back with the service">
            <BulletList items={profile.shares} />
          </Section>

          <Section title="Credentials and exposure">
            <BulletList items={profile.credentialInputs} />
            <div className="rounded-lg bg-emerald-50 p-3 text-sm leading-6 text-emerald-950">
              Primary keys and credential-shaped config fields are encrypted at rest and decrypted
              only on the server for a fetch. Browser responses receive a masked key preview and
              secret-field metadata, never the secret values. A configured key preview is last-four
              only.
            </div>
          </Section>

          <Section title="Billing and subscription coverage">
            <p className="text-sm leading-6 text-gray-600">{profile.billing.summary}</p>
          </Section>

          <Section title="What else could be connected">
            <BulletList items={profile.canAdd} />
          </Section>

          <Section title="What cannot be connected">
            <BulletList items={profile.cannotAdd} />
          </Section>

          <Section title="Known limitations">
            <BulletList items={profile.limitations} />
          </Section>

          <Section title="Confidence and source date">
            <p className="text-sm leading-6 text-gray-600">
              Reviewed {profile.provenance.reviewedOn} · {profile.provenance.confidence} confidence.
              This describes the app code at that date; vendor APIs and account permissions can change.
            </p>
            <ul className="space-y-1 text-xs text-gray-500">
              {profile.provenance.sources.map((source) => (
                <li key={source}>
                  <code>{source}</code>
                </li>
              ))}
            </ul>
          </Section>
        </div>
      </aside>
    </div>
  );

  return typeof document === "undefined" ? content : createPortal(content, document.body);
}
