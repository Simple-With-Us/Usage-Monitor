import type { Metadata } from "next";
import Link from "next/link";
import { ReportProblemButton } from "@/components/ReportProblemButton";
import {
  LEARN_MORE_SECTIONS,
  LEARN_MORE_SENTENCE_GAP,
} from "@/lib/learn-more-content";

export const metadata: Metadata = {
  title: "Learn More — Usage Monitor",
  description:
    "How to read provider cards, quotas, budgets, and month-to-date spend in Usage Monitor.",
};

export default function LearnMorePage() {
  return (
    <article className="mx-auto max-w-3xl space-y-8 text-sm leading-relaxed text-gray-800 dark:text-gray-200 sm:text-base">
      <header className="space-y-2 border-b border-gray-200 pb-6 dark:border-gray-700">
        <p className="text-xs font-medium uppercase tracking-wide text-orange-600 dark:text-orange-400">
          Usage Monitor
        </p>
        <h1 className="text-2xl font-semibold tracking-tight text-gray-900 dark:text-white sm:text-3xl">
          Learn More
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          How to read the dashboard: provider cards, numbers, time windows, and
          what to do when something looks off.
        </p>
      </header>

      {LEARN_MORE_SECTIONS.map((section) => (
        <section key={section.id} id={section.id} className="space-y-3">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
            {section.title}
          </h2>
          {section.paragraphs.map((paragraph) => (
            <p key={paragraph.slice(0, 48)}>{paragraph}</p>
          ))}
          {section.bullets ? (
            <ul className="list-disc space-y-2 pl-5">
              {section.bullets.map((item) => (
                <li key={item.slice(0, 48)}>{item}</li>
              ))}
            </ul>
          ) : null}
        </section>
      ))}

      <section className="space-y-3 border-t border-gray-200 pt-6 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
          More Help
        </h2>
        <p>
          {`The `}
          <Link
            className="text-orange-600 underline underline-offset-2 dark:text-orange-400"
            href="/support"
          >
            Support
          </Link>
          {` page covers the iPhone apps and connection troubleshooting.${LEARN_MORE_SENTENCE_GAP}`}
          <ReportProblemButton className="text-orange-600 underline underline-offset-2 dark:text-orange-400">
            Report a Problem
          </ReportProblemButton>
          {` opens an in-app form when error reporting is enabled.`}
        </p>
      </section>
    </article>
  );
}
