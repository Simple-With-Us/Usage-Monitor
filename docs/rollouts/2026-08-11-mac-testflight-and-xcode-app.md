# 2026-08-11 — Mac TestFlight launch + Xcode.app ship path

## Mac: installs from TestFlight but does not open

**Evidence on this host (Apple silicon, macOS 27 beta):**

- Apps present under `/Applications/Usage Client Monitor.app` and
  `Usage Local Monitor.app` (iOS-on-Mac wrapper layout).
- `open -a "Usage Client Monitor"` fails with **CoreServices -10671**.
- Direct binary exec exits immediately (**exit 137** when forced).
- Installed TF builds still stamped `MinimumOSVersion = 26.0` (pre-#1095),
  `BuildMachineOSBuild = 26A5353q` (macOS 27 beta), SDK `iphoneos26.5`.

**Primary cause:** TF builds required **iOS 26.0** while the Mac "Designed for
iPhone" runtime could not launch them (open -10671). Min OS is now **17.0** on
main (#1095); a **new ship + reinstall** is required for Mac.

**Secondary hardening (this PR):**

- Skip `BGTaskScheduler` registration / schedule on `isiOSAppOnMac` (background
  fetch is not reliable for iOS-on-Mac and has failed launch paths).
- Prefer multi-window scene + default desktop window size so Mac chrome is usable.
- Fleet ship scripts pin `DEVELOPER_DIR` to **`/Applications/Xcode.app`** (not
  Xcode-beta) for ASC/TestFlight compatibility.

## ASC Invalid Binary

TestFlight VALID ≠ App Store review. Builds from **beta macOS** still risk
`INVALID_BINARY` within minutes of submit. Use **Xcode.app** always; if review
still rejects, rebuild on **stable macOS / Xcode Cloud**.

## Ship

```bash
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
bash scripts/ios-ship-testflight.sh --force-ship
bash scripts/ios-ship-testflight-local.sh --force-ship
```
