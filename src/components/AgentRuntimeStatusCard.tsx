"use client";

import React, { useEffect, useState } from "react";
import { CheckCircle, Clock, Server } from "lucide-react";
import type { MacHealthResponse } from "@/lib/mac-health";

const SENTENCE_GAP = "\u00a0 ";

interface AgentAppDefinition {
  id: string;
  name: string;
  category: "Primary Fleet" | "Support Seat" | "Retired";
  processKey: string;
  logoSrc: string;
  description: string;
  worktreePath?: string;
  statusOverride?: "retired" | "running" | "stopped";
}

const FLEET_AGENTS: AgentAppDefinition[] = [
  {
    id: "antigravity",
    name: "Google Antigravity",
    category: "Primary Fleet",
    processKey: "antigravity",
    logoSrc: "/logos/antigravity.svg",
    description: "Gemini 3.7 / 3.6 Flash & Pro IDE language server with live sliding quota meter.",
    worktreePath: "~/apps/usage-antigravity",
  },
  {
    id: "claude",
    name: "Claude Code (Monet)",
    category: "Primary Fleet",
    processKey: "claude",
    logoSrc: "/logos/claude.svg",
    description: "Claude 3.7 Sonnet & Opus 5 CLI harness with OTLP telemetry & session token tracking.",
    worktreePath: "~/apps/trading-claude",
  },
  {
    id: "cursor",
    name: "Cursor Desktop & Cloud",
    category: "Primary Fleet",
    processKey: "cursor",
    logoSrc: "/logos/cursor.png",
    description: "Cursor Cloud Agent bridge & local ACP daemon with codebase embedding multiplier.",
    worktreePath: "~/apps/cursor-chat-surfaces",
  },
  {
    id: "grok",
    name: "Grok Build CLI",
    category: "Primary Fleet",
    processKey: "grok",
    logoSrc: "/logos/grok.svg",
    description: "SuperGrok Heavy xAI agent harness with turn-by-turn cost ticks.",
    worktreePath: "~/apps/trading-grok",
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    category: "Support Seat",
    processKey: "codex",
    logoSrc: "/logos/codex.svg",
    description: "ChatGPT Plus/Pro rolling rate-limit window with local session token ledger.",
    worktreePath: "~/apps/trading-codex",
  },
  {
    id: "deepseek",
    name: "DeepSeek Harness (dsh)",
    category: "Support Seat",
    processKey: "deepseek",
    logoSrc: "/logos/deepseek.svg",
    description: "DeepSeek v4 Pro & Flash ACP stdio runtime and headless session engine.",
    worktreePath: "~/apps/dsh-runtime",
  },
  {
    id: "kimi",
    name: "Kimi Code",
    category: "Retired",
    processKey: "kimi",
    logoSrc: "/logos/monet.svg",
    description: "Retired per fleet protocol — inactive across all effort boards and queues.",
    statusOverride: "retired",
  },
];

export default function AgentRuntimeStatusCard() {
  const [health, setHealth] = useState<MacHealthResponse | null>(null);

  useEffect(() => {
    let unmounted = false;
    const fetchHealth = async () => {
      try {
        const res = await fetch("/api/health/mac", { cache: "no-store" });
        if (res.ok) {
          const json = await res.json();
          if (!unmounted) setHealth(json);
        }
      } catch {
        // preserve previous state
      }
    };

    fetchHealth();
    const timer = setInterval(fetchHealth, 30000);
    return () => {
      unmounted = true;
      clearInterval(timer);
    };
  }, []);

  const processes = health?.mac?.processes || {};
  const isHostOnline = health?.status === "online" || health?.status === "degraded";

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden shadow-sm">
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-semibold text-gray-800 dark:text-gray-100 flex items-center gap-2">
            <Server className="h-4 w-4 text-blue-600 dark:text-blue-400" />
            Local Agent Runtimes & Applications
          </h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            Real-time execution status of local agent daemons on {health?.mac?.hostname || "Mac host"}.
            {SENTENCE_GAP}Green indicates the daemon or IDE is ready to accept agent tasks.
          </p>
        </div>
        <div className="text-right shrink-0">
          <span
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-full ${
              isHostOnline
                ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800"
                : "bg-rose-50 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300 border border-rose-200 dark:border-rose-800"
            }`}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${isHostOnline ? "bg-emerald-500 animate-pulse" : "bg-rose-500"}`} />
            {isHostOnline ? "Host Connected" : "Host Offline"}
          </span>
        </div>
      </div>

      <div className="p-6 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {FLEET_AGENTS.map((agent) => {
          const rawStatus = agent.statusOverride || processes[agent.processKey] || "stopped";
          const isRetired = agent.statusOverride === "retired" || agent.category === "Retired";
          const isRunning = isHostOnline && rawStatus === "running";

          return (
            <div
              key={agent.id}
              className={`p-4 rounded-lg border transition-all ${
                isRetired
                  ? "bg-gray-50/50 dark:bg-gray-900/20 border-gray-200 dark:border-gray-800 opacity-60"
                  : isRunning
                  ? "bg-emerald-50/20 dark:bg-emerald-950/10 border-emerald-200/60 dark:border-emerald-800/40"
                  : "bg-gray-50/30 dark:bg-gray-900/40 border-gray-200 dark:border-gray-700"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2.5">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={agent.logoSrc}
                    alt={`${agent.name} logo`}
                    className="w-7 h-7 object-contain rounded-md p-0.5 bg-white dark:bg-gray-900 border border-gray-100 dark:border-gray-700 shadow-2xs shrink-0"
                    width={28}
                    height={28}
                  />
                  <div>
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100 leading-tight">
                      {agent.name}
                    </h3>
                    <span className="text-[10px] uppercase font-semibold tracking-wider text-gray-500 dark:text-gray-400">
                      {agent.category}
                    </span>
                  </div>
                </div>
                {isRetired ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                    Retired
                  </span>
                ) : isRunning ? (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300">
                    <CheckCircle className="h-3 w-3" />
                    Running
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-medium bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400">
                    <Clock className="h-3 w-3" />
                    Idle / Stopped
                  </span>
                )}
              </div>

              <p className="mt-2.5 text-xs text-gray-600 dark:text-gray-300 line-clamp-2">
                {agent.description}
              </p>

              {agent.worktreePath && (
                <div className="mt-3 pt-2 border-t border-gray-100 dark:border-gray-700/50 flex items-center justify-between text-[11px] font-mono text-gray-500 dark:text-gray-400">
                  <span className="truncate">{agent.worktreePath}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
