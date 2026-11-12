"use client";

import React, { useState } from "react";
import FleetQuotaMatrixCard from "@/components/FleetQuotaMatrixCard";
import ApiEquivalentCostCard from "@/components/ApiEquivalentCostCard";
import AgentRuntimeStatusCard from "@/components/AgentRuntimeStatusCard";
import { Bot, Cpu, Gauge, Info, Layers, RefreshCw, ShieldCheck, Sparkles, Terminal } from "lucide-react";

const SENTENCE_GAP = "\u00a0 ";

export default function AgentsPageClient() {
  const [refreshKey, setRefreshKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const handleRefresh = () => {
    setRefreshing(true);
    setRefreshKey((k) => k + 1);
    setTimeout(() => setRefreshing(false), 800);
  };

  return (
    <div className="space-y-6" key={refreshKey}>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Bot className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
            Fleet AI Agents & Quota Intelligence
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Real-time quota availability, local daemon health, and shadow API-equivalent cost calculations for all coding agents.
            {SENTENCE_GAP}Excludes end-user production app calls (routed cleanly through OpenRouter).
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition shadow-sm"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`} />
            Refresh Telemetry
          </button>
        </div>
      </div>

      {/* Overview Stat Highlights */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Active Fleet Seats</span>
            <Bot className="h-4 w-4 text-indigo-500" />
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">6 active</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Antigravity, Monet, Cursor, Grok, Codex, DeepSeek (Kimi retired)
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Quota Monitoring</span>
            <Gauge className="h-4 w-4 text-emerald-500" />
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">4 sliding pools</p>
          <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1">
            5h burst windows & 7-day rolling pools
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Shadow PAYG Value</span>
            <Sparkles className="h-4 w-4 text-amber-500" />
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">LiteLLM catalog</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            Calculates token value vs flat subscriptions
          </p>
        </div>

        <div className="bg-white dark:bg-gray-800 p-4 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
          <div className="flex items-center justify-between text-gray-500 dark:text-gray-400">
            <span className="text-xs font-medium uppercase tracking-wider">Traffic Separation</span>
            <ShieldCheck className="h-4 w-4 text-blue-500" />
          </div>
          <p className="text-2xl font-bold text-gray-900 dark:text-gray-100 mt-2">100% isolated</p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
            End-user app calls bypass agent telemetry
          </p>
        </div>
      </div>

      {/* 1. Live Model Quota Matrix Card */}
      <FleetQuotaMatrixCard />

      {/* 2. API Equivalent Shadow Cost Card */}
      <ApiEquivalentCostCard />

      {/* 3. Local Mac Agent Runtimes & Applications */}
      <AgentRuntimeStatusCard />

      {/* Data Provenance & Methodology Explanatory Card */}
      <div className="bg-indigo-50/50 dark:bg-indigo-950/20 border border-indigo-100 dark:border-indigo-900/40 rounded-xl p-5 text-xs text-indigo-900 dark:text-indigo-200">
        <h3 className="font-semibold text-sm flex items-center gap-1.5 text-indigo-950 dark:text-indigo-100">
          <Info className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          How Agent Telemetry & Shadow PAYG Costs Are Derived
        </h3>
        <ul className="mt-2.5 space-y-1.5 list-disc list-inside text-indigo-800/90 dark:text-indigo-300">
          <li>
            <b>Live Quota Windows:</b> Queried from local language servers and CLI sessions (e.g. <code>agy -p &quot;/usage&quot;</code>), showing exact percentages and reset countdowns.
          </li>
          <li>
            <b>Session Token Metrics:</b> Parsed turn-by-turn from local transcript ledgers across Antigravity (<code>~/.gemini/antigravity/brain</code>), Claude Code (<code>~/.claude/projects</code>), Grok Build (<code>~/.grok/sessions</code>), Codex CLI (<code>~/.codex/sessions</code>), Copilot, and DeepSeek Harness.
          </li>
          <li>
            <b>Shadow PAYG Pricing:</b> Multiplies exact prompt, output, cache-read, and cache-creation tokens against the bundled LiteLLM public pricing catalog to demonstrate the true dollar value delivered by flat developer subscriptions.
          </li>
          <li>
            <b>Clean Traffic Isolation:</b> Production app API requests (Socratic.Trade, Congress.Trade) run directly through OpenRouter or provider API keys and are recorded separately under Providers/Money, ensuring dev tasks never distort user traffic metrics.
          </li>
        </ul>
      </div>
    </div>
  );
}
