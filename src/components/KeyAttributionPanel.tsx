"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";

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

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const inputClass = "w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100";
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
      setError(caught instanceof Error ? caught.message : "Failed to load attribution");
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
      setError(caught instanceof Error ? caught.message : "Failed to create identity");
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
      setError(caught instanceof Error ? caught.message : "Failed to create binding");
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
      setError(caught instanceof Error ? caught.message : "Failed to close binding");
    } finally {
      setPending(false);
    }
  }

  async function retireIdentity(targetIdentityId: string) {
    if (!window.confirm("Retire this identity and close its active mappings now? Historical attribution will be preserved.")) return;
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
      setError(caught instanceof Error ? caught.message : "Failed to retire identity");
    } finally {
      setPending(false);
    }
  }

  if (loading && !data) return <p className="text-sm text-gray-500">Loading key attribution…</p>;

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100">API key attribution</h1>
        <p className="mt-2 max-w-3xl text-sm text-gray-600 dark:text-gray-300">
          Map provider-reported key identities and app-local key references without storing API keys.
          Unknown or conflicting usage remains explicitly unattributed; mappings apply only from their effective date.
        </p>
      </header>

      {error ? <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">{error}</p> : null}

      {data ? (
        <>
          <section aria-labelledby="coverage-title" className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
            <h2 id="coverage-title" className="font-semibold text-gray-900 dark:text-gray-100">Current-month pushed v2 coverage</h2>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <Metric label="Proven additive key cost" value={money.format(data.coverage.totalCostUsd)} />
              <Metric label="Identity matched" value={money.format(data.coverage.identityMatchedCostUsd)} />
              <Metric label="Unattributed" value={money.format(data.coverage.identityUnattributedCostUsd)} warning={data.coverage.identityUnattributedCostUsd !== 0} />
            </div>
            <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{data.coverage.note} {data.coverage.unclassifiedCostEventCount} cost record(s) are currently unclassified; {data.coverage.excludedNonKeyScopeEventCount} non-key record(s) are excluded from key counts.</p>
          </section>

          <div className="grid gap-6 lg:grid-cols-2">
            <form onSubmit={createIdentity} className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <h2 className="font-semibold text-gray-900 dark:text-gray-100">Register provider key identity</h2>
              <Field label="Provider">
                <select required value={providerId} onChange={(event) => setProviderId(event.target.value)} className={inputClass}>
                  <option value="">Select provider</option>
                  {data.providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.displayName}</option>)}
                </select>
              </Field>
              <Field label="Alias"><input required maxLength={120} value={alias} onChange={(event) => setAlias(event.target.value)} className={inputClass} placeholder="Production key reported by provider" /></Field>
              <Field label="Description"><input maxLength={500} value={description} onChange={(event) => setDescription(event.target.value)} className={inputClass} placeholder="Optional account, team, or purpose" /></Field>
              <Field label="Provider-reported opaque key ID">
                <input type="password" maxLength={512} autoComplete="off" value={providerReportedKeyId} onChange={(event) => setProviderReportedKeyId(event.target.value)} className={inputClass} placeholder="Optional; HMAC-fingerprinted and discarded" />
              </Field>
              <p className="text-xs text-gray-500">The raw value is never stored or returned. Current v2 producer references are not auto-matched to this value; create an explicit binding below. This field is not a replacement for the provider credential used to poll billing.</p>
              <button disabled={pending} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">Register identity</button>
            </form>

            <form id="binding-form" onSubmit={createBinding} className="space-y-4 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800">
              <h2 className="font-semibold text-gray-900 dark:text-gray-100">{replaceBindingId ? "Atomically reassign an app key reference" : "Bind an app key reference"}</h2>
              <Field label="Provider key identity">
                <select required value={identityId} onChange={(event) => setIdentityId(event.target.value)} className={inputClass}>
                  <option value="">Select identity</option>
                  {data.identities.filter((identity) => identity.status === "active").map((identity) => <option key={identity.id} value={identity.id}>{identity.provider.displayName} — {identity.alias}</option>)}
                </select>
              </Field>
              <Field label="Producer ID"><input required maxLength={160} value={producerId} onChange={(event) => setProducerId(event.target.value)} className={inputClass} placeholder="congress-trade" /></Field>
              <Field label="Producer key reference"><input required maxLength={160} value={producerKeyRef} onChange={(event) => setProducerKeyRef(event.target.value)} className={inputClass} placeholder="configured-openai-primary" /></Field>
              <Field label="Provider connection reference"><input maxLength={160} value={providerConnectionRef} onChange={(event) => setProviderConnectionRef(event.target.value)} className={inputClass} placeholder="Optional exact v2 context" /></Field>
              <Field label="Billing account reference"><input maxLength={160} value={billingAccountRef} onChange={(event) => setBillingAccountRef(event.target.value)} className={inputClass} placeholder="Optional exact v2 context" /></Field>
              {providerConnectionRef && billingAccountRef ? null : <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950/30 dark:text-amber-200"><strong>Broad-scope mapping:</strong> each blank context is a wildcard. This binding can match the same producer/key reference across any missing connection or account value. Fill both when the producer supplies them.</p>}
              <Field label="Project">
                <select value={projectId} onChange={(event) => setProjectId(event.target.value)} className={inputClass}>
                  <option value="">Unattributed project</option>
                  {data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
                </select>
              </Field>
              <Field label="Effective from">
                <input required type="datetime-local" value={bindingEffectiveFrom} onChange={(event) => setBindingEffectiveFrom(event.target.value)} className={inputClass} />
              </Field>
              <p className="text-xs text-gray-500">The selected local time is stored as an exact timestamp. Reassignment closes the old row and creates the new row atomically at this same instant.</p>
              <div className="flex flex-wrap gap-3">
                <button disabled={pending} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{replaceBindingId ? "Reassign atomically" : "Create effective binding"}</button>
                {replaceBindingId ? <button type="button" disabled={pending} onClick={() => setReplaceBindingId("")} className="text-sm font-semibold text-gray-600 disabled:opacity-50">Cancel reassignment</button> : null}
              </div>
            </form>
          </div>

          {data.coverage.unattributedBuckets.length > 0 ? (
            <section aria-labelledby="unattributed-title" className="rounded-xl border border-amber-200 bg-amber-50/50 dark:border-amber-900 dark:bg-amber-950/20">
              <h2 id="unattributed-title" className="border-b border-amber-200 px-5 py-4 font-semibold text-gray-900 dark:border-amber-900 dark:text-gray-100">Unattributed key references</h2>
              <p className="px-5 pt-4 text-sm text-gray-600 dark:text-gray-300">These are exact non-secret producer references from api_key-scope v2 records. Select “Map reference” to prefill an effective binding; missing references remain explicitly unassignable.</p>
              <ul className="divide-y divide-amber-200 dark:divide-amber-900">
                {data.coverage.unattributedBuckets.map((bucket) => (
                  <li key={JSON.stringify(bucket)} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 text-sm">
                    <div>
                      <p className="font-medium text-gray-900 dark:text-gray-100">{bucket.providerName} · {bucket.producerId} / {bucket.producerKeyRef ?? "no key reference"}</p>
                      <p className="mt-1 text-xs text-gray-500">{bucket.reason.replaceAll("_", " ")} · {bucket.eventCount} record(s) · {money.format(bucket.costUsd)} proven additive cost{bucket.providerConnectionRef ? ` · connection ${bucket.providerConnectionRef}` : ""}{bucket.billingAccountRef ? ` · account ${bucket.billingAccountRef}` : ""}</p>
                    </div>
                    <button type="button" disabled={pending || !bucket.producerKeyRef} onClick={() => prepareMapping(bucket)} className="text-xs font-semibold text-blue-700 disabled:text-gray-400 dark:text-blue-300">Map reference</button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section aria-labelledby="identities-title" className="rounded-xl border border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
            <h2 id="identities-title" className="border-b border-gray-200 px-5 py-4 font-semibold text-gray-900 dark:border-gray-700 dark:text-gray-100">Registered identities</h2>
            {data.identities.length === 0 ? <p className="px-5 py-6 text-sm text-gray-500">No key identities registered. Usage stays unattributed until an administrator confirms a mapping.</p> : (
              <ul className="divide-y divide-gray-200 dark:divide-gray-700">
                {data.identities.map((identity) => (
                  <li key={identity.id} className="space-y-3 px-5 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div><p className="font-medium text-gray-900 dark:text-gray-100">{identity.alias}</p><p className="text-xs text-gray-500">{identity.provider.displayName}{identity.providerKeyFingerprint ? ` · ${identity.providerKeyFingerprint}` : " · no provider ID"}</p></div>
                      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">{money.format(data.coverage.byIdentity[identity.id]?.costUsd ?? 0)} <span className="font-normal text-gray-500">· {data.coverage.byIdentity[identity.id]?.eventCount ?? 0} v2 records this month</span></p>
                      {identity.status === "active" ? (
                        <button type="button" disabled={pending} onClick={() => void retireIdentity(identity.id)} className="text-xs font-semibold text-gray-500 hover:text-red-600 disabled:opacity-50">Retire identity</button>
                      ) : (
                        <span className="rounded-full bg-gray-100 px-2 py-1 text-xs text-gray-600 dark:bg-gray-700 dark:text-gray-300">retired</span>
                      )}
                    </div>
                    {identity.description ? <p className="text-sm text-gray-600 dark:text-gray-300">{identity.description}</p> : null}
                    <ul className="space-y-2">
                      {identity.bindings.map((binding) => (
                        <li key={binding.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-gray-50 px-3 py-2 text-xs dark:bg-gray-900/60">
                          <span><strong>{binding.producerId}</strong> / {binding.producerKeyRef}{binding.projectName || binding.project?.name ? ` → ${binding.projectName ?? binding.project?.name}` : " → project unattributed"}<span className="mt-1 block text-gray-500">effective {new Date(binding.effectiveFrom).toLocaleString()} → {binding.effectiveTo ? new Date(binding.effectiveTo).toLocaleString() : "open"}{binding.providerConnectionRef ? ` · connection ${binding.providerConnectionRef}` : ""}{binding.billingAccountRef ? ` · account ${binding.billingAccountRef}` : ""}</span></span>
                          {binding.effectiveTo ? <span>closed</span> : <span className="flex gap-3"><button type="button" disabled={pending} onClick={() => prepareMapping({ ...binding, identityId: identity.id, replaceBindingId: binding.id })} className="font-semibold text-blue-600 disabled:opacity-50">Reassign</button><button type="button" disabled={pending} onClick={() => void closeBinding(binding.id)} className="font-semibold text-gray-600 disabled:opacity-50">Close</button></span>}
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
  return <div className={`rounded-lg p-3 ${warning ? "bg-amber-50 dark:bg-amber-950/30" : "bg-gray-50 dark:bg-gray-900/60"}`}><p className="text-xs text-gray-500">{label}</p><p className="mt-1 text-lg font-semibold text-gray-900 dark:text-gray-100">{value}</p></div>;
}
