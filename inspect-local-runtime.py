import collections
import datetime
import json
from pathlib import Path
import re
import subprocess

root = Path(__file__).resolve().parent
log = subprocess.run(["docker", "logs", "--since", "90m", "--tail", "2500", "b4ac1ea66fd1"], capture_output=True, text=True, check=True)
lines = (log.stdout + log.stderr).splitlines()
levels = collections.Counter()
syntax = collections.Counter()
categories = collections.Counter()
last_timestamps = {}
terms = ["storage cap exceeded", "download_cap_exceeded", "upload_cap_exceeded", "database is locked", "sqlite_busy", "compaction", "sync", "checkpoint", "upload", "timeout", "connection", "retry"]
for line in lines:
    if "level=" in line:
        syntax["go_level_records"] += 1
    if re.search(r'"level"\s*:', line):
        syntax["json_level_records"] += 1
    match = re.search(r'(?:level=|"level"\s*:\s*")(WARN|ERROR)\b', line, re.IGNORECASE)
    if not match:
        continue
    level = match.group(1).upper()
    levels[level] += 1
    found = False
    for term in terms:
        if term in line.lower():
            categories[f"{level}:{term}"] += 1
            found = True
    if not found:
        categories[f"{level}:other"] += 1
    stamp = re.search(r'time=([^ ]+)', line)
    if stamp:
        last_timestamps[level] = stamp.group(1)
keyword_counts = {term: sum(term in line.lower() for line in lines) for term in ["error", "warn", "archive_failed", "download_cap_exceeded", "upload_cap_exceeded", "storage cap exceeded", "checksum mismatch"]}
error_context = []
for line in lines:
    if "error" not in line.lower():
        continue
    severity = re.search(r'level=(\w+)', line)
    allowlist = {"missing", "unknown", "config", "path", "file", "fatal", "error", "errors", "failed", "exit", "provider", "poll", "metrics", "r2", "archive", "disabled", "litestream", "cannot", "upload", "download", "key", "unsupported", "schema", "synced", "migration", "database", "node", "module", "require", "cache", "deprecated", "build", "warning", "user", "password", "secret", "wrong", "status", "http", "s3", "reason", "uncaught", "allocation", "invalid", "time", "format", "log", "enoent", "eacces", "operation", "timed", "out", "no", "not", "code", "active", "unverified", "details", "recent", "directory", "safe", "npm", "info", "du", "data"}
    words = set(re.findall(r'[a-z]+', line.lower()))
    error_context.append({"severity": severity.group(1) if severity else "no_go_level", "termClasses": [term for term in ["archive", "r2", "sqlite", "prisma", "timeout", "metrics", "ingest", "otlp", "503", "429", "price", "parse", "api_request", "codex", "litestream"] if term in line.lower()], "allowlistedWords": sorted(words.intersection(allowlist)), "looksLikeDuListing": bool(re.search(r'^\s*[0-9.]+[KMG]?\s+/data/', line))})
result = {"scope": "Existing local container logs, last 90 minutes and maximum 2500 lines; Go/JSON WARN/ERROR and bounded keyword counts", "lineCount": len(lines), "syntaxCounts": dict(syntax), "levelCounts": dict(levels), "keywordCounts": keyword_counts, "genericErrorKeywordContext": error_context, "categoryCounts": dict(categories), "lastTimestamps": last_timestamps}
archive = subprocess.run(["docker", "exec", "b4ac1ea66fd1", "cat", "/data/.r2-archive-status.json"], capture_output=True, text=True)
if archive.returncode == 0:
    data = json.loads(archive.stdout)
    error = str(data.get("error", data.get("lastError", ""))).lower()
    result["r2ExistingStatus"] = {"ok": data.get("ok"), "reason": data.get("reason"), "checkedAt": data.get("checkedAt"), "fieldNames": sorted(data), "errorClasses": [term for term in ["download_cap_exceeded", "upload_cap_exceeded", "accessdenied", "access denied", "timeout", "timed out", "credential", "checksum", "bucket", "r2_weekly_archive_max", "cap exceeded", "disabled"] if term in error]}
path = root / "local-runtime-log-summary.json"
path.write_text(json.dumps(result, indent=2) + "\n")
path.chmod(0o600)
print(json.dumps(result, indent=2))
