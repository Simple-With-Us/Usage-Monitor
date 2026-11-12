# 2026-09-03 — AppUpdatePrompt reads ai-fleet-coordinator

Owner is deleting `jaywedgeworth22/ios-app-versions`.  Personal-Site does not
link it.  Client and Local iOS copies stay byte-identical to
`scripts/ios-fleet/AppUpdatePrompt.swift` and now fetch
`site/ios-versions.json` from `jaywedgeworth22/ai-fleet-coordinator`.

## Verification

```bash
bash scripts/ios-fleet-pin.sh --check
diff scripts/ios-fleet/AppUpdatePrompt.swift ios/UsageMonitor/App/AppUpdatePrompt.swift
diff scripts/ios-fleet/AppUpdatePrompt.swift ios/UsageMonitor/LocalApp/AppUpdatePrompt.swift
```
