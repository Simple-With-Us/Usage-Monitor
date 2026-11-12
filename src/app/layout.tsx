import type { Metadata } from "next";
import { headers } from "next/headers";
import DatadogRumInit from "@/components/DatadogRumInit";
import Nav from "@/components/Nav";
import PwaRegistration from "@/components/PwaRegistration";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Usage Monitor",
  description: "Monitor usage and balance across multiple API providers",
  icons: {
    icon: [
      { url: "/brand/icon-64.png", sizes: "64x64", type: "image/png" },
      { url: "/icon.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon.ico", sizes: "any" },
    ],
    apple: "/brand/icon-192.png",
  },
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: {
      index: false,
      follow: false,
      noimageindex: true,
    },
  },
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Middleware sets x-nonce; attach it to inline boot scripts so CSP allows them.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var d = localStorage.getItem('display-density') || 'compact';
                  document.documentElement.classList.add('density-' + d);
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body className="bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100 antialiased min-h-screen pb-[env(safe-area-inset-bottom)]">
        <ThemeProvider
          attribute="class"
          // Owner 2026-08-10: light is the default. System/dark remain
          // selectable in the nav; do not boot into dark from OS preference.
          defaultTheme="light"
          enableSystem
          nonce={nonce}
        >
          {/* WCAG 2.4.1 bypass block. focus:z-[100] clears the z-50 sticky Nav. */}
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-white focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-gray-900 focus:shadow-lg focus:outline-none focus:ring-2 focus:ring-accent dark:focus:bg-gray-900 dark:focus:text-gray-100"
          >
            Skip to main content
          </a>
          <Nav />
          <main
            id="main-content"
            tabIndex={-1}
            className="max-w-7xl mx-auto px-3 py-5 pt-[max(1.25rem,env(safe-area-inset-top))] sm:px-6 sm:py-8 lg:px-8 focus:outline-none"
          >
            {children}
          </main>
          <PwaRegistration />
          <DatadogRumInit />
        </ThemeProvider>
      </body>
    </html>
  );
}
