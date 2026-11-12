"use client";

import { openFeedbackOrMailto } from "@/components/ReportProblemButton";
import {
  useState,
  useEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { Monitor, Moon, Search, Sun } from "lucide-react";
import { setStoredDisplayDensity, useDisplayDensity } from "@/lib/display-density";
import CommandPalette from "@/components/CommandPalette";
import { splitNavLinks, type NavLink } from "@/components/nav-link-split";
import { useNavViewportTier } from "@/components/use-nav-viewport-tier";

const PRIMARY_LINKS: NavLink[] = [
  { href: "/", label: "Overview" },
  { href: "/agents", label: "Agents" },
  { href: "/providers", label: "Providers" },
  { href: "/money", label: "Money" },
  { href: "/projects", label: "Projects" },
  { href: "/alerts", label: "Alerts" },
  { href: "/platforms", label: "Platforms" },
  { href: "/ops", label: "Ops" },
  { href: "/settings", label: "Settings" },
];

const SECONDARY_LINKS: NavLink[] = [
  { href: "/learn-more", label: "Learn More" },
  { href: "/attribution", label: "Keys & Apps" },
  { href: "/cost-by-session", label: "Cost by Session" },
];

function isLinkActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Brand mark: same orange circuit/sync app icon as favicon + iOS client. */
function BrandMark({ className = "h-8 w-8" }: { className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static brand asset; avoid layout shift from next/image
    <img
      src="/brand/icon-64.png"
      alt=""
      width={32}
      height={32}
      className={`shrink-0 rounded-lg ${className}`}
      aria-hidden="true"
      decoding="async"
    />
  );
}

export function triggerSentryFeedback() {
  openFeedbackOrMailto();
}

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const moreRef = useRef<HTMLDivElement>(null);
  const prefsRef = useRef<HTMLDivElement>(null);

  const { theme, setTheme } = useTheme();
  const density = useDisplayDensity();
  const navTier = useNavViewportTier();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  useEffect(() => {
    setMenuOpen(false);
    setMoreOpen(false);
    setPrefsOpen(false);
  }, [pathname]);

  // At xl every link is inline and MoreMenu unmounts (no overflow links), but
  // moreOpen lives here and would survive: reset it so the dropdown does not
  // reappear already open when the viewport narrows back below xl.
  useEffect(() => {
    if (navTier === "xl") setMoreOpen(false);
  }, [navTier]);

  useEffect(() => {
    if (!moreOpen && !prefsOpen) return;
    const onPointer = (event: MouseEvent) => {
      const t = event.target as Node;
      if (moreOpen && moreRef.current && !moreRef.current.contains(t)) {
        setMoreOpen(false);
      }
      if (prefsOpen && prefsRef.current && !prefsRef.current.contains(t)) {
        setPrefsOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [moreOpen, prefsOpen]);

  const handleLogout = async () => {
    setLogoutPending(true);
    setLogoutError("");
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Log out failed");
      }
      router.replace("/login");
      router.refresh();
    } catch (error) {
      setLogoutError(error instanceof Error ? error.message : "Log out failed");
    } finally {
      setLogoutPending(false);
    }
  };

  if (pathname === "/login" || pathname.startsWith("/login/")) return null;

  const mobileLinks = [...PRIMARY_LINKS, ...SECONDARY_LINKS];

  const tierForSplit = navTier ?? "md";
  const { main: desktopMainLinks, overflow: desktopOverflowLinks } = splitNavLinks(
    PRIMARY_LINKS,
    SECONDARY_LINKS,
    tierForSplit
  );

  return (
    <>
      <nav
        aria-label="Primary navigation"
        className="sticky top-0 z-50 border-b border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900"
      >
        <div className="mx-auto max-w-7xl px-3 sm:px-6 lg:px-8">
          {/*
            Single row, never wrap: logo | flexible nav (scroll if needed) | tools.
            Previous layout put 7 links + theme + density + logout in one flex row
            that overflowed mid breakpoints → overlapping text ("MoreLight", etc.).
          */}
          <div className="flex h-14 min-h-14 items-center gap-2 sm:h-16 sm:gap-3">
            <Link
              href="/"
              className="flex min-w-0 shrink-0 items-center gap-2"
              aria-label="Usage Monitor home"
            >
              <BrandMark />
              {/*
                Always show the product name next to the icon — including mobile.
                The iOS apps list as "Usage Monitor Client" and "Usage Monitor Local";
                their home-screen labels are "Usage Monitor" and "Local Monitor".
                The website brand is plain "Usage Monitor".
              */}
              <span className="truncate text-sm font-semibold tracking-tight text-gray-900 dark:text-gray-100 sm:text-base">
                Usage Monitor
              </span>
            </Link>

            {/* Desktop / tablet nav — one link row + one More; scroll clips links only */}
            <div className="hidden min-w-0 flex-1 items-center gap-0.5 md:flex">
              <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto overflow-y-visible [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {desktopMainLinks.map((link) => {
                  const isActive = isLinkActive(pathname, link.href);
                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      aria-current={isActive ? "page" : undefined}
                      className={`inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-md px-2 text-sm font-medium transition-colors lg:px-2.5 ${
                        isActive
                          ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                          : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                      }`}
                    >
                      {link.label}
                    </Link>
                  );
                })}
              </div>
              {desktopOverflowLinks.length > 0 && (
                <MoreMenu
                  moreRef={moreRef}
                  moreOpen={moreOpen}
                  setMoreOpen={setMoreOpen}
                  onToggle={() => setPrefsOpen(false)}
                  secondaryActive={desktopOverflowLinks.some((l) => isLinkActive(pathname, l.href))}
                  links={desktopOverflowLinks}
                  pathname={pathname}
                />
              )}
            </div>

            {/* Right tools: never shrink; compact chrome on narrow desktop */}
            <div className="ml-auto hidden shrink-0 items-center gap-1.5 md:flex lg:gap-2">
              <button
                type="button"
                onClick={() => setCommandOpen(true)}
                aria-label="Open command palette (⌘K)"
                title="Command palette (⌘K)"
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-accent xl:h-11 xl:w-auto xl:px-2.5 xl:py-2 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              >
                <Search size={16} aria-hidden="true" />
                <span className="hidden text-xs font-medium text-gray-500 xl:inline dark:text-gray-400">
                  ⌘K
                </span>
              </button>

              {mounted && (
                <div className="relative" ref={prefsRef}>
                  <button
                    type="button"
                    aria-expanded={prefsOpen}
                    aria-haspopup="menu"
                    onClick={() => {
                      setPrefsOpen((v) => !v);
                      setMoreOpen(false);
                    }}
                    className={`inline-flex h-11 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors ${
                      prefsOpen
                        ? "border-gray-300 bg-gray-100 text-gray-900 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100"
                        : "border-gray-200 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800"
                    }`}
                  >
                    <span className="hidden sm:inline">Display</span>
                    <span className="sm:hidden" aria-hidden="true">
                      ···
                    </span>
                    <span className="text-[10px] opacity-70" aria-hidden="true">
                      ▾
                    </span>
                  </button>
                  {prefsOpen && (
                    <div
                      role="menu"
                      className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-gray-200 bg-white p-3 shadow-lg dark:border-gray-700 dark:bg-gray-900"
                    >
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Theme
                      </p>
                      <div
                        className="mb-3 flex items-center gap-0.5 rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-700 dark:bg-gray-800/80"
                        role="group"
                        aria-label="Theme selector"
                      >
                        {(["light", "dark", "system"] as const).map((t) => {
                          const active = theme === t;
                          const Icon = t === "dark" ? Moon : t === "light" ? Sun : Monitor;
                          const label = t.charAt(0).toUpperCase() + t.slice(1);
                          return (
                            <button
                              key={t}
                              type="button"
                              role="menuitemradio"
                              aria-checked={active}
                              onClick={() => setTheme(t)}
                              title={`Set theme to ${label}`}
                              className={`flex flex-1 items-center justify-center gap-1 rounded-md px-1.5 py-1.5 text-xs font-medium transition-all ${
                                active
                                  ? "border border-gray-200/80 bg-white text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                                  : "border border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                              }`}
                            >
                              <Icon size={13} aria-hidden="true" />
                              <span>{label}</span>
                            </button>
                          );
                        })}
                      </div>
                      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                        Density
                      </p>
                      <div
                        className="flex items-center gap-0.5 rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-700 dark:bg-gray-800/80"
                        role="group"
                        aria-label="Display density selector"
                      >
                        {(["compact", "comfortable"] as const).map((d) => {
                          const active = density === d;
                          const label = d === "compact" ? "Compact" : "Comfortable";
                          return (
                            <button
                              key={d}
                              type="button"
                              role="menuitemradio"
                              aria-checked={active}
                              onClick={() => setStoredDisplayDensity(d)}
                              title={`Set display density to ${label}`}
                              className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-all ${
                                active
                                  ? "border border-gray-200/80 bg-white text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                                  : "border border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                              }`}
                            >
                              {label}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-3 border-t border-gray-200 pt-2.5 dark:border-gray-700">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setPrefsOpen(false);
                            triggerSentryFeedback();
                          }}
                          className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs font-medium text-gray-600 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                        >
                          <span>Report a Problem</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {logoutError && (
                <span role="alert" className="max-w-32 truncate text-xs text-red-600 dark:text-red-300">
                  {logoutError}
                </span>
              )}
              <button
                type="button"
                onClick={handleLogout}
                disabled={logoutPending}
                className="inline-flex min-h-11 shrink-0 items-center whitespace-nowrap rounded-md px-2.5 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              >
                {logoutPending ? "…" : "Log Out"}
              </button>
            </div>

            {/* Mobile hamburger */}
            <div className="ml-auto flex items-center gap-1 md:hidden">
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  setCommandOpen(true);
                }}
                aria-label="Open command palette"
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-accent dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              >
                <Search className="h-5 w-5" aria-hidden="true" />
              </button>
              <button
                type="button"
                aria-expanded={menuOpen}
                aria-controls="mobile-navigation"
                aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
                onClick={() => setMenuOpen((open) => !open)}
                className="inline-flex h-11 w-11 items-center justify-center rounded-lg text-gray-600 hover:bg-gray-100 hover:text-gray-900 focus:outline-none focus:ring-2 focus:ring-accent dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              >
                <svg aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d={menuOpen ? "M6 18L18 6M6 6l12 12" : "M4 6h16M4 12h16M4 18h16"}
                  />
                </svg>
              </button>
            </div>
          </div>

          {menuOpen && (
            <div
              id="mobile-navigation"
              className="space-y-2 border-t border-gray-200 py-3 dark:border-gray-800 md:hidden"
            >
              {mobileLinks.map((link) => {
                const isActive = isLinkActive(pathname, link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    onClick={() => setMenuOpen(false)}
                    aria-current={isActive ? "page" : undefined}
                    className={`block min-h-11 rounded-lg px-3 py-2.5 text-sm font-medium ${
                      isActive
                        ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                        : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
                    }`}
                  >
                    {link.label}
                  </Link>
                );
              })}
              <div className="space-y-2 px-3 py-2">
                {mounted && (
                  <>
                    <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Theme</div>
                    <div
                      className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-700 dark:bg-gray-800/80"
                      role="group"
                      aria-label="Theme selector"
                    >
                      {(["light", "dark", "system"] as const).map((t) => {
                        const active = theme === t;
                        const Icon = t === "dark" ? Moon : t === "light" ? Sun : Monitor;
                        const label = t.charAt(0).toUpperCase() + t.slice(1);
                        return (
                          <button
                            key={t}
                            type="button"
                            onClick={() => setTheme(t)}
                            aria-pressed={active}
                            className={`flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition-all ${
                              active
                                ? "border border-gray-200/80 bg-white text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                                : "border border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                            }`}
                          >
                            <Icon size={14} />
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Density</div>
                    <div
                      className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-100 p-0.5 dark:border-gray-700 dark:bg-gray-800/80"
                      role="group"
                      aria-label="Display density selector"
                    >
                      {(["compact", "comfortable"] as const).map((d) => {
                        const active = density === d;
                        const label = d === "compact" ? "Compact" : "Comfortable";
                        return (
                          <button
                            key={d}
                            type="button"
                            onClick={() => setStoredDisplayDensity(d)}
                            aria-pressed={active}
                            className={`min-h-11 flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-all ${
                              active
                                ? "border border-gray-200/80 bg-white text-gray-900 shadow-sm dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100"
                                : "border border-transparent text-gray-500 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                            }`}
                          >
                            {label}
                          </button>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  triggerSentryFeedback();
                }}
                className="block min-h-11 w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              >
                Report a Problem
              </button>
              <button
                type="button"
                onClick={handleLogout}
                disabled={logoutPending}
                className="block min-h-11 w-full rounded-lg px-3 py-2.5 text-left text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 disabled:opacity-50 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
              >
                {logoutPending ? "Logging out…" : "Log Out"}
              </button>
              {logoutError && (
                <p role="alert" className="px-3 py-1 text-xs text-red-600 dark:text-red-300">
                  {logoutError}
                </p>
              )}
            </div>
          )}
        </div>
      </nav>
      <CommandPalette open={commandOpen} onOpenChange={setCommandOpen} />
    </>
  );
}

function MoreMenu({
  moreRef,
  moreOpen,
  setMoreOpen,
  onToggle,
  secondaryActive,
  links,
  pathname,
}: {
  moreRef: RefObject<HTMLDivElement | null>;
  moreOpen: boolean;
  setMoreOpen: Dispatch<SetStateAction<boolean>>;
  onToggle?: () => void;
  secondaryActive: boolean;
  links: NavLink[];
  pathname: string;
}) {
  if (links.length === 0) return null;
  return (
    <div className="relative shrink-0" ref={moreRef}>
      <button
        type="button"
        aria-expanded={moreOpen}
        aria-haspopup="menu"
        onClick={() => {
          onToggle?.();
          setMoreOpen((v) => !v);
        }}
        className={`inline-flex min-h-11 items-center whitespace-nowrap rounded-md px-2 text-sm font-medium transition-colors lg:px-2.5 ${
          secondaryActive || moreOpen
            ? "bg-gray-100 text-gray-900 dark:bg-gray-800 dark:text-gray-100"
            : "text-gray-600 hover:bg-gray-50 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-100"
        }`}
      >
        More
        <span className="ml-1 text-[10px] opacity-70" aria-hidden="true">
          ▾
        </span>
      </button>
      {moreOpen && (
        <div
          role="menu"
          className="absolute left-0 top-full z-50 mt-1 min-w-[10rem] overflow-hidden rounded-lg border border-gray-200 bg-white py-1 shadow-lg dark:border-gray-700 dark:bg-gray-900"
        >
          {links.map((link) => {
            const isActive = isLinkActive(pathname, link.href);
            return (
              <Link
                key={link.href}
                role="menuitem"
                href={link.href}
                onClick={() => setMoreOpen(false)}
                aria-current={isActive ? "page" : undefined}
                className={`flex min-h-11 items-center px-3 text-sm ${
                  isActive
                    ? "bg-gray-100 font-medium text-gray-900 dark:bg-gray-800 dark:text-gray-100"
                    : "text-gray-700 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
