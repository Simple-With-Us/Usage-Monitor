import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { defaultDestPath, installFromOriginMain, isEntrypoint } from "../install-agent-hook-otlp.mjs";

describe("defaultDestPath", () => {
  it("points at a stable path under ~/.local/share, outside any git worktree", () => {
    const dest = defaultDestPath();
    expect(dest).toMatch(/\.local\/share\/agent-hook-otlp\/agent-hook-otlp\.mjs$/);
  });
});

describe("isEntrypoint", () => {
  // Same symlink-safety contract as agent-hook-otlp.mjs's own isEntrypoint()
  // (found by a Sentry bot review on this PR): a bare
  // `import.meta.url === file://${argv[1]}` comparison is false when this
  // script is invoked through a symlink, silently skipping main() with no
  // error -- realpath-resolving argv[1] first fixes that.
  it("is true when argv[1]'s realpath matches import.meta.url", () => {
    const realpath = (p) => {
      expect(p).toBe("/some/symlink/install-agent-hook-otlp.mjs");
      return "/real/target/install-agent-hook-otlp.mjs";
    };
    const metaUrl = pathToFileURL("/real/target/install-agent-hook-otlp.mjs").href;
    expect(isEntrypoint(["node", "/some/symlink/install-agent-hook-otlp.mjs"], metaUrl, realpath)).toBe(true);
  });

  it("is false when running as an imported module (different file)", () => {
    const realpath = (p) => p;
    const metaUrl = pathToFileURL("/real/target/install-agent-hook-otlp.mjs").href;
    expect(isEntrypoint(["node", "/some/other/script.mjs"], metaUrl, realpath)).toBe(false);
  });

  it("is false when argv has no script path", () => {
    expect(isEntrypoint(["node"], "file:///x", () => "/x")).toBe(false);
  });

  it("falls back to a literal comparison when realpath throws (e.g. deleted mid-run)", () => {
    const realpath = () => {
      throw new Error("ENOENT");
    };
    const metaUrl = pathToFileURL("/real/target/install-agent-hook-otlp.mjs").href;
    expect(isEntrypoint(["node", "/real/target/install-agent-hook-otlp.mjs"], metaUrl, realpath)).toBe(true);
    expect(isEntrypoint(["node", "/other/path.mjs"], metaUrl, realpath)).toBe(false);
  });
});

describe("installFromOriginMain", () => {
  it("fetches origin/main, reads the file's content from it (never from the working tree), and writes it to dest", () => {
    const execFileSyncImpl = vi.fn((cmd, args, opts) => {
      if (args.includes("fetch")) return "";
      if (args.includes("show")) {
        expect(args).toEqual(["-C", "/repo", "show", "origin/main:scripts/agent-hook-otlp.mjs"]);
        return "// agent-hook-otlp fixture content\n";
      }
      throw new Error(`unexpected git invocation: ${args.join(" ")}`);
    });
    const written = [];
    const writeFileSyncImpl = vi.fn((path, content, opts) => written.push({ path, content, opts }));
    const mkdirSyncImpl = vi.fn();
    const chmodSyncImpl = vi.fn();
    const readFileSyncImpl = vi.fn(() => "// agent-hook-otlp fixture content\n");

    const result = installFromOriginMain(
      { repo: "/repo", dest: "/dest/agent-hook-otlp.mjs" },
      {
        execFileSync: execFileSyncImpl,
        writeFileSync: writeFileSyncImpl,
        mkdirSync: mkdirSyncImpl,
        chmodSync: chmodSyncImpl,
        readFileSync: readFileSyncImpl,
      }
    );

    expect(execFileSyncImpl).toHaveBeenCalledWith("git", ["-C", "/repo", "fetch", "-q", "origin", "main"], expect.any(Object));
    expect(mkdirSyncImpl).toHaveBeenCalledWith("/dest", { recursive: true });
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe("/dest/agent-hook-otlp.mjs");
    expect(written[0].content).toContain("agent-hook-otlp fixture content");
    expect(chmodSyncImpl).toHaveBeenCalledWith("/dest/agent-hook-otlp.mjs", 0o755);
    expect(result).toEqual({ dest: "/dest/agent-hook-otlp.mjs", size: expect.any(Number) });
  });

  it("throws rather than installing garbage when origin/main's content does not look like the real script", () => {
    const execFileSyncImpl = vi.fn((cmd, args) => (args.includes("show") ? "not the right file at all" : ""));
    expect(() =>
      installFromOriginMain(
        { repo: "/repo", dest: "/dest/agent-hook-otlp.mjs" },
        { execFileSync: execFileSyncImpl, writeFileSync: vi.fn(), mkdirSync: vi.fn(), chmodSync: vi.fn(), readFileSync: vi.fn() }
      )
    ).toThrow(/unexpected content/);
  });
});
