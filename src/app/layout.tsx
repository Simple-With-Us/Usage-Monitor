import type { Metadata } from "next";
import Nav from "@/components/Nav";
import PwaRegistration from "@/components/PwaRegistration";
import { ThemeProvider } from "@/components/ThemeProvider";
import "./globals.css";

export const metadata: Metadata = {
  title: "Usage Monitor",
  description: "Monitor usage and balance across multiple API providers",
  applicationName: "Usage Monitor",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Usage Monitor",
  },
  formatDetection: {
    telephone: false,
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

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
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
      <body className="bg-gray-50 text-gray-900 dark:bg-gray-900 dark:text-gray-100 antialiased min-h-screen">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
          <PwaRegistration />
          <Nav />
          <main className="max-w-7xl mx-auto px-3 py-5 sm:px-6 sm:py-8 lg:px-8">
            {children}
          </main>
        </ThemeProvider>
      </body>
    </html>
  );
}
