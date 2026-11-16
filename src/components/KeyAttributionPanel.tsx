"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { formatCurrency } from "@/lib/format";

interface Choice { id: string; name: string; displayName?: string }
interface Binding {
  id: string;
  projectId: string | null;
  projectName: string | null;
  producerId: string;
  producerKeyRef: string;
  providerConnectionRef: string | null;
  billingAccountRef: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  project: { id: string; name: string } | null;
}
interface Identity {
  id: string;
  providerId: string;
  provider: { name: string; displayName: string };
  alias: string;
  description: string | null;
  providerKeyFingerprint: string | null;
  status: string;
  bindings: Binding[];
}
interface Coverage {
  scope: "pushed_v2_cost_events";
  totalCostUsd: number;
  identityMatchedCostUsd: number;
  identityUnattributedCostUsd: number;
  projectAttributedCostUsd: number;
  projectUnattributedCostUsd: number;
  projectAuthorityConflictCostUsd: number;
  projectAuthorityConflictEventCount: number;
  totalEventCount: number;
  identityMatchedEventCount: number;
  identityUnattributedEventCount: number;
  unclassifiedCostEventCount: number;
  excludedNonKeyScopeEventCount: number;
  reasons: Record<string, { costUsd: number; eventCount: number }>;
  byIdentity: Record<string, { costUsd: number; eventCount: number }>;
  unattributedBuckets: Array<{
    providerName: string;
    producerId: string;
    producerKeyRef: string | null;
    providerConnectionRef: string | null;
    billingAccountRef: string | null;
    reason: string;
    costUsd: number;
    eventCount: number;
    unclassifiedCostEventCount: number;
  }>;
  note: string;
}
interface Payload {
  identities: Identity[];
  providers: Choice[];
  projects: Choice[];
  coverage: Coverage;
}

const money = (amount: number) => formatCurrency(amount);
const inputClass = "w-full min-h-11 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100";
const toLocalDateTime = (value: Date) => {
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

async function requestJson(input: RequestInfo, init?: RequestInit) {
  const response = await fetch(input, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}

export default function KeyAttributionPanel() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [providerId, setProviderId] = useState("");
  const [alias, setAlias] = useState("");
  const [description, setDescription] = useState("");
  const [providerReportedKeyId, setProviderReportedKeyId] = useState("");
  const [identityId, setIdentityId] = useState("");
  const [producerId, setProducerId] = useState("");
  const [producerKeyRef, setProducerKeyRef] = useState("");
  const [providerConnectionRef, setProviderConnectionRef] = useState("");
  const [billingAccountRef, setBillingAccountRef] = useState("");
  const [projectId, setProjectId] = useState("");
  const [bindingEffectiveFrom, setBindingEffectiveFrom] = useState(() => toLocalDateTime(new Date()));
  const [replaceBindingId, setReplaceBindingId] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await requestJson("/api/key-attribution"));
      setError("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not load keys.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function createIdentity(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      await requestJson("/api/key-attribution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_identity",
          providerId,
          alias,
          description,
          providerReportedKeyId,
        }),
      });
      setAlias("");
      setDescription("");
      setProviderReportedKeyId("");
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this key.");
    } finally {
      setPending(false);
    }
  }

  async function createBinding(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      await requestJson("/api/key-attribution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "create_binding",
          identityId,
          producerId,
          producerKeyRef,
          providerConnectionRef,
          billingAccountRef,
          projectId,
          replaceBindingId,
          effectiveFrom: new Date(bindingEffectiveFrom).toISOString(),
        }),
      });
      setProducerKeyRef("");
      setProviderConnectionRef("");
      setBillingAccountRef("");
      setReplaceBindingId("");
      setBindingEffectiveFrom(toLocalDateTime(new Date()));
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save this match.");
    } finally {
      setPending(false);
    }
  }

  function prepareMapping(values: {
    producerId: string;
    producerKeyRef: string | null;
    providerConnectionRef: string | null;
    billingAccountRef: string | null;
    projectId?: string | null;
    identityId?: string;
    replaceBindingId?: string;
  }) {
    if (!values.producerKeyRef) return;
    setProducerId(values.producerId);
    setProducerKeyRef(values.producerKeyRef);
    setProviderConnectionRef(values.providerConnectionRef ?? "");
    setBillingAccountRef(values.billingAccountRef ?? "");
    setProjectId(values.projectId ?? "");
    if (values.identityId) setIdentityId(values.identityId);
    setReplaceBindingId(values.replaceBindingId ?? "");
    setBindingEffectiveFrom(toLocalDateTime(new Date()));
    document.getElementById("binding-form")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function closeBinding(bindingId: string) {
    setPending(true);
    try {
      await requestJson("/api/key-attribution", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "close_binding", bindingId, effectiveTo: new Date().toISOString() }),
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not close this match.");
    } finally {
      setPending(false);
    }
  }

  async function retireIdentity(targetIdentityId: string) {
    if (!window.confirm("Remove this key and close its active matches now?\u00A0 Past cost stays as it was.")) return;
    setPending(true);
    try {
      await requestJson("/api/key-attribution", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "retire_identity",
          identityId: targetIdentityId,
          effectiveTo: new Date().toISOString(),
        }),
      });
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not remove this key.");
    } finally {
      setPending(false);
    }
  }

  if (loading && !data) return <p className="text-sm text-gray-500 dark:text-gray-400">Loading key attribution…</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">API Key Attribution</h1>
        <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-300">
          Match a provider&apos;s key name to the app that uses it.{"\u00A0 "}The key itself is never stored.{"\u00A0 "}Usage that does not match stays listed on its own.{"\u00A0 "}A match starts on the date you set.
        </p>
      </header>

      {error ? <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p> : null}

      {data ? (
        <>
          <section aria-labelledby="coverage-title" className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <h2 id="coverage-title" className="font-semibold text-gray-900 dark:text-gray-100">Key Coverage This Month</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Metric label="Key cost" value={money(data.coverage.totalCostUsd)} />
              <Metric label="Matched" value={money(data.coverage.identityMatchedCostUsd)} />
              <Metric label="Not matched" value={money(data.coverage.identityUnattributedCostUsd)} warning={data.coverage.identityUnattributedCostUsd !== 0} />
            </div>
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">Key cost counts only reports that name a key.{"\u00A0 "}Reports that span a match change, or that do not name a key, stay out of these totals.{"\u00A0 "}{data.coverage.unclassifiedCostEventCount} cost record(s) are still unsorted.{"\u00A0 "}{data.coverage.excludedNonKeyScopeEventCount} other record(s) are left out of the key totals.</p>
            {data.coverage.projectAuthorityConflictEventCount > 0 ? <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"><strong>Project mismatch:</strong> {data.coverage.projectAuthorityConflictEventCount} report(s) totaling {money(data.coverage.projectAuthorityConflictCostUsd)} name a different project than the match.{"\u00A0 "}The key match stays.{"\u00A0 "}The project stays unmatched until you correct it.</p> : null}
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <form onSubmit={createIdentity} className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <h2 className="font-semibold text-gray-900 dark:text-gray-100">Register a Provider Key</h2>
              <Field label="Provider">
                <select required value={providerId} onChange={(event) => setProviderId(event.target.value)} className={inputClass}>
                  <option value="">Select provider</option>
                  {data.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
                </select>
              </Field>
              <Field label="Alias"><input required maxLength={120} value={alias} onChange={(event) => setAlias(event.target.value)} className={inputClass} placeholder="Production key reported by provider" /></Field>
              <Field label="Description"><input maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} className={inputClass} placeholder="Optional account, team, or purpose" /></Field>
              <Field label="Key id from the provider">
                <input type="password" maxLength={512} autoComplete="off" value={providerReportedKeyId} onChange={(event) => setProviderReportedKeyId(event.target.value)} className={inputClass} placeholder="Optional. Stored only as a fingerprint." />
              </Field>
              <p className="text-xs text-gray-500 dark:text-gray-400">The raw value is never stored or returned.{"\u00A0 "}Usage reports are not matched to this value on their own.{"\u00A0 "}Add a binding below.{"\u00A0 "}This is not the credential used to read the provider bill.</p>
              <button disabled={pending} className="inline-flex min-h-11 items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Register Key</button>
            </form>

            <form id="binding-form" onSubmit={createBinding} className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <h2 className="font-semibold text-gray-900 dark:text-gray-100">{replaceBindingId ? "Reassign an App Key" : "Match an App Key"}</h2>
              <Field label="Provider key">
                <select required value={identityId} onChange={(event) => setIdentityId(event.target.value)} className={inputClass}>
                  <option value="">Select a key</option>
                  {data.identities.filter((identity) => identity.status === "active").map((identity) => <option key={identity.id} value={identity.id}>{identity.provider.displayName} — {identity.alias}</option>)}
                </select>
              </Field>
              <Field label="App name"><input required maxLength={160} value={producerId} onChange={(event) => setProducerId(event.target.value)} className={inputClass} placeholder="your-app" /></Field>
              <Field label="Key reference"><input required maxLength={160} value={producerKeyRef} onChange={(event) => setProducerKeyRef(event.target.value)} className={inputClass} placeholder="primary-key" /></Field>
              <Field label="Connection reference"><input maxLength={160} value={providerConnectionRef} onChange={(event) => setProviderConnectionRef(event.target.value)} className={inputClass} placeholder="Optional exact context" /></Field>
              <Field label="Billing account reference"><input maxLength={160} value={billingAccountRef} onChange={(event) => setBillingAccountRef(event.target.value)} className={inputClass} placeholder="Optional exact context" /></Field>
              {providerConnectionRef && billingAccountRef ? null : <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"><strong>Wide match:</strong> a blank field matches any value.{"\u00A0 "}Fill both when the app sends them.</p>}
              <Field label="Project">
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className={inputClass}>
                  <option value="">No project</option>
                  {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </Field>
              <Field label="Effective from">
                <input required type="datetime-local" value={bindingEffectiveFrom} onChange={(event) => setBindingEffectiveFrom(event.target.value)} className={inputClass} />
              </Field>
              <p className="text-xs text-gray-500 dark:text-gray-400">The time you pick is saved exactly.{"\u00A0 "}Reassigning closes the previous match and starts the new one at that same moment.</p>
              <div className="flex flex-wrap gap-3">
                <button disabled={pending} className="inline-flex min-h-11 items-center rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{replaceBindingId ? "Reassign" : "Create Binding"}</button>
                {replaceBindingId ? <button type="button" disabled={pending} onClick={() => setReplaceBindingId("")} className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-gray-600 disabled:opacity-50 dark:text-gray-300">Cancel</button> : null}
              </div>
            </form>
          </div>

          {data.coverage.unattributedBuckets.length > 0 ? (
            <section aria-labelledby="unattributed-title" className="rounded-xl border border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20">
              <h2 id="unattributed-title" className="border-b border-amber-200 px-5 py-4 font-semibold text-gray-900 dark:border-amber-900 dark:text-gray-100">Unattributed Key References</h2>
              <p className="px-5 pt-4 text-sm text-gray-600 dark:text-gray-300">These key references are not tied to a project yet.{"\u00A0 "}Choose Map Reference to fill the form.{"\u00A0 "}A reference with no key cannot be mapped.</p>
              <ul className="divide-y divide-amber-200 dark:divide-amber-900">
                {data.coverage.unattributedBuckets.map((bucket) => (
                  <li key={JSON.stringify(bucket)} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm">
                    <div>
                      <p className="font-medium text-gray-900 dark:text-gray-100">{bucket.providerName} · {bucket.producerId} / {bucket.producerKeyRef ?? "no key reference"}</p>
                      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">{bucket.reason.replaceAll("_", " ")} · {bucket.eventCount} record(s) · {money(bucket.costUsd)}{bucket.providerConnectionRef ? ` · connection ${bucket.providerConnectionRef}` : ""}{bucket.billingAccountRef ? ` · account ${bucket.billingAccountRef}` : ""}</p>
                    </div>
                    <button type="button" disabled={pending || !bucket.producerKeyRef} onClick={() => prepareMapping(bucket)} className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-blue-700 disabled:text-gray-400 dark:text-blue-300">Map Reference</button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="identities-title" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
            <h2 id="identities-title" className="border-b border-gray-200 px-5 py-4 font-semibold text-gray-900 dark:border-gray-700 dark:text-gray-100">Saved Keys</h2>
            {data.identities.length === 0 ? <p className="px-5 py-6 text-sm text-gray-500 dark:text-gray-400">No keys saved yet.{"\u00A0 "}Usage stays unmatched until you confirm a match.</p> : (
              <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                {data.identities.map((identity) => (
                  <li key={identity.id} className="space-y-3 px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div><p className="font-medium text-gray-900 dark:text-gray-100">{identity.alias}</p><p className="text-xs text-gray-500 dark:text-gray-400">{identity.provider.displayName}{identity.providerKeyFingerprint ? ` · ${identity.providerKeyFingerprint}` : " · no key id"}</p></div>
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{money(data.coverage.byIdentity[identity.id]?.costUsd ?? 0)} <span className="font-normal text-gray-500 dark:text-gray-400">· {data.coverage.byIdentity[identity.id]?.eventCount ?? 0} reports this month</span></p>
                      {identity.status === "active" ? (
                        <button type="button" disabled={pending} onClick={() => void retireIdentity(identity.id)} className="inline-flex min-h-11 items-center px-3 text-sm font-semibold text-gray-500 hover:text-red-600 disabled:opacity-50 dark:text-gray-400">Remove Key</button>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">retired</span>
                      )}
                    </div>
                    {identity.description ? <p className="text-sm text-gray-600 dark:text-gray-300">{identity.description}</p> : null}
                    <ul className="space-y-2">
                      {identity.bindings.map((binding) => (
                        <li key={binding.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-gray-900/60">
                          <span><strong>{binding.producerId}</strong> / {binding.producerKeyRef}{binding.projectName || binding.project?.name ? ` → ${binding.projectName ?? binding.project?.name}` : " → no project yet"}<span className="mt-1 block text-gray-500 dark:text-gray-400">from {new Date(binding.effectiveFrom).toLocaleString()} to {binding.effectiveTo ? new Date(binding.effectiveTo).toLocaleString() : "open"}{binding.providerConnectionRef ? ` · connection ${binding.providerConnectionRef}` : ""}{binding.billingAccountRef ? ` · account ${binding.billingAccountRef}` : ""}</span></span>
                          {binding.effectiveTo ? <span>closed</span> : <span className="flex gap-3"><button type="button" disabled={pending} onClick={() => prepareMapping({ ...binding, identityId: identity.id, replaceBindingId: binding.id })} className="inline-flex min-h-11 items-center px-3 font-semibold text-blue-600 disabled:opacity-50">Reassign</button><button type="button" disabled={pending} onClick={() => void closeBinding(binding.id)} className="inline-flex min-h-11 items-center px-3 font-semibold text-gray-600 disabled:opacity-50 dark:text-gray-300">Close</button></span>}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">{label}<span className="mt-1 block">{children}</span></label>;
}

function Metric({ label, value, warning = false }: { label: string; value: string; warning?: boolean }) {
  return <div className={`rounded-lg p-3 ${warning ? "bg-amber-50 dark:bg-amber-950/30" : "bg-gray-50 dark:bg-gray-900/60"}`}><p className="text-xs text-gray-500 dark:text-gray-400">{label}</p><p className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{value}</p></div>;
}
