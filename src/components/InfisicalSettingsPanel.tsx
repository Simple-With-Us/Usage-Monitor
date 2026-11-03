"use client";

import { useEffect, useState } from "react";
type Source = "um" | "st" | "ct" | "shared" | "st-primary";
type Token = { id: string; paths: string[]; permissions: ("read" | "write")[]; token?: string; configured?: boolean };
type Connection = { source: Source; projectId: string; mode: "machine-identity" | "service-tokens"; secretPath: string; readPaths: string[]; writePaths: string[]; clientId?: string; clientSecret?: string; clientIdConfigured?: boolean; clientSecretConfigured?: boolean; writePermissionsVerified?: boolean; tokens: Token[] };
const empty = (source: Source): Connection => ({ source, projectId: "", mode: "service-tokens", secretPath: "/", readPaths: ["/"], writePaths: [], tokens: [{ id: "read", paths: ["/"], permissions: ["read"] }] });
const labels: Record<Source, string> = { um: "Usage Monitor", st: "Socratic.Trade", ct: "Congress.Trade", shared: "Shared", "st-primary": "Socratic.Trade Provider Bridge" };
const fieldClass = "mt-1 w-full rounded border border-gray-300 bg-white p-2 text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100";
const split = (value: string) => value === "" ? [] : value.split("\n").map((path) => path.trim());

export default function InfisicalSettingsPanel() {
  const [saved, setSaved] = useState<Connection[]>([]);
  const [form, setForm] = useState<Connection>(empty("um"));
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [disabled, setDisabled] = useState<Source[]>([]);
  const [unreadable, setUnreadable] = useState<Source[]>([]);
  useEffect(() => {
    let active = true;
    void fetch("/api/settings/infisical").then(async (response) => {
      if (!response.ok) throw new Error();
      const body = await response.json();
      if (!Array.isArray(body.connections)) throw new Error();
      if (active) { setSaved(body.connections); setDisabled(body.disabledSources ?? []); setUnreadable((body.sourceErrors ?? []).map((item: { source: Source }) => item.source)); setForm(body.connections.find((item: Connection) => item.source === "um") ?? empty("um")); setLoaded(true); }
    }).catch(() => { if (active) { setMessage("Could not load Infisical connections; enter all credentials to replace a connection or disable it"); setLoaded(true); } });
    return () => { active = false; };
  }, []);
  const update = (patch: Partial<Connection>) => setForm((current) => ({ ...current, ...patch }));
  const updateToken = (index: number, patch: Partial<Token>) => update({ tokens: form.tokens.map((token, i) => i === index ? { ...token, ...patch } : token) });
  async function save() {
    setBusy(true); setMessage("");
    const { clientIdConfigured: _id, clientSecretConfigured: _secret, writePermissionsVerified: _verified, ...input } = form;
    void _id; void _secret; void _verified;
    try {
      const response = await fetch("/api/settings/infisical", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...input, tokens: input.tokens.map(({ configured: _configured, ...token }) => { void _configured; return token; }) }) });
      if (!response.ok) throw new Error();
      const body = await response.json();
      setSaved((current) => [...current.filter((item) => item.source !== form.source), body.connection]);
      setDisabled((current) => current.filter((source) => source !== form.source));
      setUnreadable((current) => current.filter((source) => source !== form.source));
      setForm(body.connection); setMessage(body.connection.writePermissionsVerified === false ? "Connection saved; read access verified and machine identity write permissions remain unverified" : "Connection verified and saved");
    } catch { setMessage("Connection could not be verified or saved"); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/settings/infisical", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: form.source }) });
      if (!response.ok) throw new Error();
      setSaved((current) => current.filter((item) => item.source !== form.source)); setDisabled((current) => [...current.filter((source) => source !== form.source), form.source]); setForm(empty(form.source));
      setUnreadable((current) => current.filter((source) => source !== form.source));
      setMessage("Connection disabled; environment credentials will not be used for this project use");
    } catch { setMessage("Connection could not be removed"); }
    finally { setBusy(false); }
  }
  return <section className="rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-800" aria-label="Infisical connections">
    <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Infisical Connections</h2>
    <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">Choose credentials for each project.  Folders are exact and never include subfolders automatically.</p>
    <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Credentials stay hidden.  Leave a credential blank to keep it when its project and folder permissions are unchanged; Disable Connection prevents environment credentials from taking over.</p>
    {unreadable.includes(form.source) && <p role="alert" className="mt-2 text-sm text-amber-800 dark:text-amber-200">This connection could not be loaded.  Enter all credentials to replace it, or disable it.</p>}
    {disabled.includes(form.source) && <p className="mt-2 text-sm text-gray-700 dark:text-gray-200">This connection is disabled.  Save new credentials to enable it again.</p>}
    {form.mode === "machine-identity" && form.writePaths.length > 0 && <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">Machine identity write permissions are unverified.  Infisical must authorize each settings write.</p>}
    <fieldset disabled={busy || !loaded} className="mt-4 grid gap-4 sm:grid-cols-2">
      <label className="text-sm">Project Use<select className={fieldClass} value={form.source} onChange={(event) => { const source = event.target.value as Source; setForm(saved.find((item) => item.source === source) ?? empty(source)); setMessage(""); }}>{Object.entries(labels).map(([source, label]) => <option value={source} key={source}>{label}</option>)}</select></label>
      <label className="text-sm">Authentication<select className={fieldClass} value={form.mode} onChange={(event) => update({ mode: event.target.value as Connection["mode"], clientId: "", clientSecret: "", tokens: event.target.value === "service-tokens" ? [{ id: "read", paths: form.readPaths, permissions: ["read"] }] : [], writePaths: [] })}><option value="service-tokens">Service Tokens</option><option value="machine-identity">Machine Identity</option></select></label>
      <label className="text-sm">Infisical Project ID<input className={fieldClass} value={form.projectId} onChange={(event) => update({ projectId: event.target.value })} /></label>
      <label className="text-sm">Primary Read Folder<input className={fieldClass} value={form.secretPath} onChange={(event) => update({ secretPath: event.target.value })} /></label>
      <label className="text-sm">Read Folders (One Per Line)<textarea className={fieldClass} value={form.readPaths.join("\n")} onChange={(event) => update({ readPaths: split(event.target.value) })} /></label>
      <label className="text-sm">Write Folders (One Per Line)<textarea className={fieldClass} value={form.writePaths.join("\n")} onChange={(event) => update({ writePaths: split(event.target.value) })} /></label>
      {form.mode === "machine-identity" ? <>
        <label className="text-sm">Client ID<input type="password" autoComplete="new-password" className={fieldClass} value={form.clientId ?? ""} placeholder={form.clientIdConfigured ? "Configured" : "Required"} onChange={(event) => update({ clientId: event.target.value })} /></label>
        <label className="text-sm">Client Secret<input type="password" autoComplete="new-password" className={fieldClass} value={form.clientSecret ?? ""} placeholder={form.clientSecretConfigured ? "Configured" : "Required"} onChange={(event) => update({ clientSecret: event.target.value })} /></label>
      </> : <div className="space-y-4 sm:col-span-2">
        {form.tokens.map((token, index) => <fieldset key={token.id} className="grid gap-3 rounded border border-gray-200 p-3 sm:grid-cols-3 dark:border-gray-600">
          <legend className="px-1 text-sm font-medium">Service Token {index + 1}</legend>
          <label className="text-sm">Permissions<select className={fieldClass} value={token.permissions.join(",")} onChange={(event) => updateToken(index, { permissions: event.target.value.split(",") as Token["permissions"] })}><option value="read">Read Only</option><option value="write">Write Only</option><option value="read,write">Read And Write</option></select></label>
          <label className="text-sm">Token Folders (One Per Line)<textarea className={fieldClass} value={token.paths.join("\n")} onChange={(event) => updateToken(index, { paths: split(event.target.value) })} /></label>
          <label className="text-sm">Service Token<input type="password" autoComplete="new-password" className={fieldClass} value={token.token ?? ""} placeholder={token.configured ? "Configured" : "Required"} onChange={(event) => updateToken(index, { token: event.target.value })} /></label>
          <button type="button" className="text-left text-sm text-red-700 dark:text-red-300" onClick={() => update({ tokens: form.tokens.filter((_, i) => i !== index) })}>Remove Token</button>
        </fieldset>)}
        {form.tokens.length < 2 && <button type="button" className="text-sm font-medium text-blue-700 dark:text-blue-300" onClick={() => update({ tokens: [...form.tokens, { id: `token-${Date.now()}`, paths: [], permissions: ["write"] }] })}>Add Service Token</button>}
      </div>}
      <div className="flex gap-4 sm:col-span-2"><button type="button" className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50" onClick={() => void save()}>Verify And Save</button>{!disabled.includes(form.source) && <button type="button" className="text-sm text-red-700 dark:text-red-300" onClick={() => void remove()}>Disable Connection</button>}</div>
    </fieldset>
    {message && <p role="status" className="mt-3 text-sm text-gray-700 dark:text-gray-200">{message}</p>}
  </section>;
}
