"use client";

import { useEffect } from "react";

import {
  isDatadogRumStarted,
  startDatadogRum,
} from "@/lib/datadog-rum-client";
import type { DatadogRumConfig } from "@/lib/datadog-options";

type PublicRumResponse =
  | { configured: false }
  | ({ configured: true } & DatadogRumConfig);

/**
 * Runtime RUM boot for Infisical-injected public tokens.
 * Renders nothing.  Incomplete config is logged, never hidden.
 */
export default function DatadogRumInit() {
  useEffect(() => {
    if (isDatadogRumStarted()) return;

    let cancelled = false;
    void fetch("/api/datadog-public-config", { credentials: "same-origin" })
      .then(async (response) => {
        if (cancelled) return;
        if (response.status === 503) {
          const body = (await response.json().catch(() => null)) as {
            error?: string;
            missing?: string[];
          } | null;
          console.error(
            "[datadog] RUM public config is incomplete; refusing to init.",
            body?.missing ?? body?.error ?? response.status
          );
          return;
        }
        if (!response.ok) {
          console.error(
            `[datadog] RUM public config failed with HTTP ${response.status}`
          );
          return;
        }
        const body = (await response.json()) as PublicRumResponse;
        if (!body.configured) return;
        startDatadogRum(body);
      })
      .catch((error: unknown) => {
        console.error("[datadog] RUM public config request failed", error);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
