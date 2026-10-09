import type { Metadata } from "next";
import Link from "next/link";
import { ReportProblemButton } from "@/components/ReportProblemButton";

export const metadata: Metadata = {
  title: "Support — Usage Monitor",
  description:
    "Support for Usage Client Monitor and Usage Local Monitor iOS apps.",
  robots: { index: true, follow: true },
};

export default function SupportPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-6 text-sm leading-relaxed text-gray-800 dark:text-gray-200 sm:text-base">
      <header className="space-y-2 border-b border-gray-200 pb-6 dark:border-gray-700">
        <p className="text-xs font-medium uppercase tracking-wide text-orange-600 dark:text-orange-400">
          Jay Wedgeworth, LLC
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white sm:text-3xl">
          Support
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Help for the Usage Monitor iOS apps and self-hosted dashboard.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Contact
        </h2>
        <p>
          Email{" "}
          <a
            className="text-orange-600 underline underline-offset-2 dark:text-orange-400"
            href="mailto:mail@jays.services"
          >
            mail@jays.services
          </a>
          . Include the app name (Usage Client Monitor or Usage Local Monitor),
          iOS version, and a short description of the issue. Do not send API
          keys or dashboard passwords.
        </p>
        <p>
          Dashboard issues can use{" "}
          <ReportProblemButton className="text-orange-600 underline underline-offset-2 dark:text-orange-400">
            Report a Problem with this dashboard
          </ReportProblemButton>
          .  That opens the in-app form when Sentry is available, otherwise
          email.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Which App Do I Have?
        </h2>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Usage Local Monitor</strong> — on-device only. Keys live in
            Keychain; no Usage Monitor server required. Banner says
            “ON-DEVICE · no server”.
          </li>
          <li>
            <strong>Usage Client Monitor</strong> — connects to a Usage Monitor
            server you host (or an instance you control). Settings holds the
            base URL and access token.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Common Fixes
        </h2>
        <ul className="list-disc space-y-2 pl-5">
          <li>
            <strong>Client cannot connect:</strong> confirm the server URL uses
            HTTPS, the token has read access, and the host allows your IP if you
            use network restrictions.
          </li>
          <li>
            <strong>Local provider shows no spend:</strong> use a management or
            admin-style key when the provider requires it for cost APIs;
            inference-only keys may only show “connected” without month-to-date
            cost.
          </li>
          <li>
            <strong>Face ID unlock:</strong> disable App Lock under Settings if
            you need to recover access via device passcode flows.
          </li>
          <li>
            <strong>Start over (Local):</strong> Settings → wipe local data
            (clears SQLite + Keychain entries for this app).
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Privacy
        </h2>
        <p>
          See the{" "}
          <Link
            className="text-orange-600 underline underline-offset-2 dark:text-orange-400"
            href="/privacy"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </section>
    </article>
  );
}
