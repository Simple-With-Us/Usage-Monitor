"use client";

import { useRef, useState } from "react";

const SENTENCE_GAP = "\u00a0 ";

export default function WorkspaceCopyCard() {
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState<"export" | "import" | "copy" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function downloadExport() {
    setBusy("export");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/workspace/export");
      if (!res.ok) throw new Error("Export failed");
      const payload = await res.json();
      const blob = new Blob([JSON.stringify(payload, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "usage-monitor-workspace-export.json";
      a.click();
      URL.revokeObjectURL(url);
      setMessage(
        `Saved a secret-free package (${payload.projects?.length ?? 0} projects, ${payload.providers?.length ?? 0} providers).  In Usage Monitor Local: Settings → Import Package.  No bundle key.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(null);
    }
  }

  async function copyExport() {
    setBusy("copy");
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/workspace/export");
      if (!res.ok) throw new Error("Export failed");
      const payload = await res.json();
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setMessage("Copied the secret-free workspace JSON to the clipboard.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Copy failed");
    } finally {
      setBusy(null);
    }
  }

  async function importFile(file: File) {
    setBusy("import");
    setError(null);
    setMessage(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const res = await fetch("/api/workspace/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        projects?: number;
        providers?: number;
        skipped?: number;
      };
      if (!res.ok) {
        throw new Error(body.error || "Import failed");
      }
      setMessage(
        `Imported ${body.projects ?? 0} projects and ${body.providers ?? 0} providers (${body.skipped ?? 0} already present). Keys were not copied. Re-enter them or run Infisical sync.`
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800 sm:p-5">
      <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        Copy Workspace For Local Testing
      </h2>
      <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">
        This JSON is the Usage Monitor Local package (projects, provider shells, plans,
        subscriptions, recent snapshots).{SENTENCE_GAP}
        There is no bundle key or passphrase.{SENTENCE_GAP}
        In Usage Monitor Local: Settings → Import Package, then pick this file.{SENTENCE_GAP}
        API keys are not included — re-enter them on the phone, or use Import Keys with a
        separate Mac .umkeys file.{SENTENCE_GAP}
        You can also import the same file here on a local Usage Monitor instance.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void downloadExport()}
          disabled={busy !== null}
          className="inline-flex min-h-11 items-center rounded-lg bg-accent px-3 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {busy === "export" ? "Preparing…" : "Download For Local"}
        </button>
        <button
          type="button"
          onClick={() => void copyExport()}
          disabled={busy !== null}
          className="inline-flex min-h-11 items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          {busy === "copy" ? "Copying…" : "Copy JSON"}
        </button>
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={busy !== null}
          className="inline-flex min-h-11 items-center rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          {busy === "import" ? "Importing…" : "Import On This Instance"}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void importFile(file);
          }}
        />
      </div>
      {message ? (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">{message}</p>
      ) : null}
      {error ? (
        <p className="mt-2 text-xs text-red-700 dark:text-red-300" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
