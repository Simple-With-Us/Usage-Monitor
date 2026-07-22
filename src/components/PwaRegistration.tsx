"use client";

import { useEffect } from "react";

/**
 * Registers the installability shell without caching authenticated pages or
 * API responses. Usage and billing data must always come from the live app;
 * the service worker deliberately has no fetch handler.
 */
export default function PwaRegistration() {
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
      return;
    }

    window.addEventListener("load", register, { once: true });
    return () => window.removeEventListener("load", register);
  }, []);

  return null;
}
