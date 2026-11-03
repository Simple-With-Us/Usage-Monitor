# iOS agent build-loop policy (Usage Monitor)

Docs/hooks only.  `ios/CLAUDE.md` is the annotated onboarding file (both UsageMonitor and LocalUsageMonitor).  `xcodebuild` via bash is pre-approved.  Do not stand up Xcode MCP.  Claude PreToolUse hook blocks `.pbxproj` / entitlements / xib writes.  XcodeGen stays `ios/UsageMonitor/project.yml` → `xcodegen generate`.  `UsageMonitorKit/Package.swift` remains agent-editable.

Canonical: `/Users/jay/apps/AG***-S**C.md` § iOS agent build loop.
