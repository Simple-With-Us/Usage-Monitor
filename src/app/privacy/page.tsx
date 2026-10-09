import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — Usage Monitor",
  description:
    "Privacy policy for Usage Client Monitor and Usage Local Monitor iOS apps and the Usage Monitor dashboard.",
  robots: { index: true, follow: true },
};

export default function PrivacyPolicyPage() {
  return (
    <article className="mx-auto max-w-3xl space-y-6 text-sm leading-relaxed text-gray-800 dark:text-gray-200 sm:text-base">
      <header className="space-y-2 border-b border-gray-200 pb-6 dark:border-gray-700">
        <p className="text-xs font-medium uppercase tracking-wide text-orange-600 dark:text-orange-400">
          Jay Wedgeworth, LLC
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white sm:text-3xl">
          Privacy Policy
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Effective August 10, 2026 · Applies to{" "}
          <strong>Usage Client Monitor</strong>,{" "}
          <strong>Usage Local Monitor</strong>, and the optional{" "}
          <strong>Usage Monitor</strong> web dashboard at usage.jays.services.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Summary
        </h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            We do <strong>not</strong> sell personal data and we do{" "}
            <strong>not</strong> use advertising or third-party analytics SDKs
            in the iOS apps.
          </li>
          <li>
            <strong>Usage Local Monitor</strong> processes API keys and cost
            figures on your device. Your keys leave the device only when you
            choose a provider and the app calls that provider’s HTTPS API.
          </li>
          <li>
            <strong>Usage Client Monitor</strong> talks only to a Usage Monitor
            server URL and read token that <em>you</em> configure (self-hosted
            or fleet). We do not receive that traffic unless you point the app
            at a server we operate and you choose to use it.
          </li>
          <li>
            No App Store account system, no tracking for ads, no sale of data.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Developer
        </h2>
        <p>
          Jay Wedgeworth, LLC (“we”, “us”). Contact:{" "}
          <a
            className="text-orange-600 underline underline-offset-2 dark:text-orange-400"
            href="mailto:mail@jays.services"
          >
            mail@jays.services
          </a>
          . Support page:{" "}
          <Link
            className="text-orange-600 underline underline-offset-2 dark:text-orange-400"
            href="/support"
          >
            usage.jays.services/support
          </Link>
          .
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Data We Process
        </h2>
        <h3 className="font-medium text-gray-900 dark:text-white">
          Usage Local Monitor (On-Device)
        </h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Provider API keys / tokens</strong> you enter — stored in
            the iOS Keychain on your device. Not uploaded to us.
          </li>
          <li>
            <strong>Usage, balance, and cost figures</strong> returned by
            providers you configure — stored in a local SQLite database on the
            device. Financial figures are processed for your budgets and
            alerts; they are not sent to the developer.
          </li>
          <li>
            Optional <strong>export packages</strong> you create — stay under
            your control (Files / share sheet). Exports never include raw API
            keys.
          </li>
          <li>
            Optional <strong>Face ID / device passcode</strong> to unlock the
            app — handled by the system; we do not see biometric templates.
          </li>
        </ul>
        <h3 className="font-medium text-gray-900 dark:text-white">
          Usage Client Monitor (Server Client)
        </h3>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Server URL</strong> and <strong>read/access token</strong>{" "}
            you enter — token in Keychain; host preference in app storage.
          </li>
          <li>
            Budget and provider summaries returned by <em>your</em> configured
            server over HTTPS. Cached on-device for offline widgets and first
            paint.
          </li>
          <li>
            Optional local notifications for budget alerts you enable.
          </li>
        </ul>
        <h3 className="font-medium text-gray-900 dark:text-white">
          Web Dashboard (If You Use a Hosted Instance)
        </h3>
        <p>
          A password-protected dashboard may store provider credentials and
          usage history on that instance’s database. If you use a third-party
          host, that host’s operators can access data on their servers. The
          public fleet instance is intended for the operator’s own monitoring;
          do not send others’ secrets there.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Third Parties You Choose
        </h2>
        <p>
          When you add a provider (for example OpenRouter, OpenAI, Anthropic,
          DeepSeek, Hetzner, Cloudflare, market-data APIs), the Local app sends
          requests to that provider’s endpoints using credentials you supply.
          Those providers’ privacy policies apply to data they receive. We do
          not sell or broker that access.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Tracking, Ads, Analytics
        </h2>
        <p>
          The iOS apps do not include advertising identifiers for ads, do not
          run third-party analytics SDKs for marketing, and do not track you
          across apps or websites for advertising. Crash reporting, if enabled
          on a self-hosted server stack you operate, is under your control.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Retention and Deletion
        </h2>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>Local app:</strong> Settings → wipe / clear local data
            removes the on-device database and associated Keychain entries for
            that app.
          </li>
          <li>
            <strong>Client app:</strong> remove the token and clear app data /
            uninstall; on-device caches and widgets clear with the app group.
          </li>
          <li>
            <strong>Self-hosted server:</strong> delete the instance database
            or provider rows according to your ops practice.
          </li>
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Children
        </h2>
        <p>
          The apps are developer tools and are not directed at children under
          13. We do not knowingly collect children’s data.
        </p>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          Changes
        </h2>
        <p>
          We may update this page. The effective date above will change when we
          do. Continued use after an update means you accept the revised
          policy.
        </p>
      </section>

      <footer className="border-t border-gray-200 pt-6 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400">
        <p>
          Related:{" "}
          <Link
            className="text-orange-600 underline underline-offset-2 dark:text-orange-400"
            href="/support"
          >
            Support
          </Link>
          .
        </p>
      </footer>
    </article>
  );
}
