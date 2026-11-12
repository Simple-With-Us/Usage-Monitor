"use client";

import { useEffect, useState } from "react";

const DISMISS_KEY = "um-pwa-install-dismissed";

/**
 * Registers the installability shell without caching authenticated pages or
 * API responses. Usage and billing data must always come from the live app;
 * the service worker deliberately has no fetch handler.
 *
 * Also surfaces a soft "Add to Home Screen" / install banner once after login
 * when the browser fires `beforeinstallprompt` (Chrome/Edge Android).
 */
export default function PwaRegistration() {
  const [installEvent, setInstallEvent] = useState<{
    prompt: () => Promise<void>;
  } | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const register = () => {
      void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch((error: unknown) => {
        if (process.env.NODE_ENV !== "production") {
          console.warn("Usage Monitor service worker registration failed", error);
        }
      });
    };

    if (document.readyState === "complete") {
      register();
    } else {
      window.addEventListener("load", register, { once: true });
    }

    let dismissed = false;
    try {
      dismissed = window.localStorage.getItem(DISMISS_KEY) === "1";
    } catch {
      dismissed = false;
    }

    const onBip = (event: Event) => {
      event.preventDefault();
      const bip = event as Event & {
        prompt: () => Promise<void>;
        userChoice?: Promise<{ outcome: string }>;
      };
      if (typeof bip.prompt !== "function") return;
      setInstallEvent({ prompt: () => bip.prompt() });
      if (!dismissed && window.location.pathname !== "/login") {
        setVisible(true);
      }
    };
    window.addEventListener("beforeinstallprompt", onBip);

    return () => {
      window.removeEventListener("load", register);
      window.removeEventListener("beforeinstallprompt", onBip);
    };
  }, []);

  if (!visible || !installEvent) return null;

  return (
    <div
      role="region"
      aria-label="Install app"
      className="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] left-1/2 z-[70] w-[min(24rem,calc(100%-1.5rem))] -translate-x-1/2 rounded-2xl border border-gray-200 bg-white p-4 shadow-xl dark:border-gray-700 dark:bg-gray-900"
    >
      <p className="text-sm font-semibold text-gray-900 dark:text-gray-100">
        Install Usage Monitor
      </p>
      <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
        Add to your home screen for a faster, app-like Overview.
      </p>
      <div className="mt-3 flex gap-2">
        <button
          type="button"
          className="min-h-11 flex-1 rounded-lg bg-accent px-3 text-sm font-medium text-white hover:opacity-90"
          onClick={() => {
            void installEvent.prompt().finally(() => setVisible(false));
          }}
        >
          Install
        </button>
        <button
          type="button"
          className="min-h-11 rounded-lg border border-gray-300 px-3 text-sm font-medium text-gray-700 dark:border-gray-600 dark:text-gray-200"
          onClick={() => {
            try {
              window.localStorage.setItem(DISMISS_KEY, "1");
            } catch {
              // ignore
            }
            setVisible(false);
          }}
        >
          Not now
        </button>
      </div>
    </div>
  );
}
