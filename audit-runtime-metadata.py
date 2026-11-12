"""Read-only bounded runtime checks; never print log lines or configuration."""
import datetime
import json
import subprocess
import urllib.request
from zoneinfo import ZoneInfo

APP = "yagelvqux9e8l1kztif7bf2o"
result = {"checkedAt": datetime.datetime.now(ZoneInfo("America/Chicago")).strftime("%B %d, %I:%M %p")}
for endpoint in ("health", "ready?strict=1"):
    try:
        req = urllib.request.Request("https://usage.jays.services/api/" + endpoint, headers={"Cache-Control": "no-cache", "User-Agent": "Fleet-Usage-Audit/1"})
        with urllib.request.urlopen(req, timeout=20) as response:
            data = json.load(response)
            safe = {"http": response.status, "ok": data.get("ok"), "status": data.get("status")}
            revision = data.get("revision")
            if isinstance(revision, str) and len(revision) == 40 and all(c in "0123456789abcdef" for c in revision):
                safe["revision"] = revision
            result[endpoint] = safe
    except Exception as error:
        result[endpoint] = {"errorClass": type(error).__name__, "http": getattr(error, "code", None)}
proc = subprocess.run(["docker", "logs", "--since", "2h", "--tail", "20000", APP], capture_output=True, timeout=30)
lines = (proc.stdout + proc.stderr).decode("utf-8", errors="replace").splitlines()
patterns = {
    "unhandledIngestFailure": "[ingest/usage] unhandled failure",
    "explicitWriterBusy": "[ingest/usage] SQLite writer busy:",
    "createMany": "externalUsageEvent.createMany",
    "operationTimedOut": "Operation has timed out",
    "genericIngestAdmissionRejection": "receiver_busy",
}
result["logs"] = {"exitCode": proc.returncode, "boundedLines": len(lines), "tailCap": 20000,
                  "patternCounts": {name: sum(pattern in line for line in lines) for name, pattern in patterns.items()}}
print(json.dumps(result))
