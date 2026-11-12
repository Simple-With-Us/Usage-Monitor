from pathlib import Path
import difflib
import hashlib
import json
import os
import shlex
import subprocess

root = Path(__file__).resolve().parent
before = root / "fleet-backups.before"
text = before.read_text()
lines = text.splitlines(keepends=True)
assert lines[0].startswith("# Jay 2026-10-31: local retention is ONE copy")
assert lines[5] == "SHELL=/bin/bash\n"
header = (
    "# Local dumps retain two days: ST 4, CT 4, UM 2 complete snapshots.\n"
    "# B2 retention unchanged: 3 dailies + 2 weeklies, 14-day maximum.\n"
    "# Root-drive mirror status requires separate verification; this config does not install it.\n"
)
proposed_lines = []
changed = []
expected = {"socratic": "4", "congress": "4", "usage-monitor": "2"}
for number, line in enumerate(lines[5:], start=6):
    updated = line
    for app, count in expected.items():
        if f"FLEET_BACKUP_APPS={app} " in line:
            old = "FLEET_BACKUP_KEEP_DAYS=3650 FLEET_BACKUP_KEEP_COUNT=1"
            new = f"FLEET_BACKUP_KEEP_DAYS=2 FLEET_BACKUP_KEEP_COUNT={count}"
            assert line.count(old) == 1
            updated = line.replace(old, new)
            changed.append(app)
    proposed_lines.append(updated)
assert sorted(changed) == sorted(expected)
proposed = header + "".join(proposed_lines)
rows = []
for line in proposed.splitlines():
    if not line or line.startswith("#") or "=" in line.split()[0]:
        continue
    parts = line.split(maxsplit=6)
    assert len(parts) == 7 and parts[5] == "root"
    command = parts[6]
    subprocess.run(["bash", "-n"], input=command, text=True, check=True)
    if "FLEET_BACKUP_APPS=" in command:
        args = shlex.split(command)
        inner = args[args.index("-c") + 1]
        flags = dict(token.split("=", 1) for token in shlex.split(inner) if "=" in token)
        app = flags["FLEET_BACKUP_APPS"]
        assert flags["FLEET_BACKUP_KEEP_DAYS"] == "2"
        assert flags["FLEET_BACKUP_KEEP_COUNT"] == expected[app]
        assert flags["B2_KEEP_DAILY"] == "3"
        assert flags["B2_KEEP_WEEKLY"] == "2"
        assert flags["B2_MAX_AGE_DAYS"] == "14"
        rows.append({"app": app, "schedule": " ".join(parts[:5]), "keepDays": 2, "keepCount": int(expected[app])})
assert len(rows) == 3
patch = "".join(difflib.unified_diff(text.splitlines(True), proposed.splitlines(True), fromfile="fleet-backups.before", tofile="fleet-backups.proposed"))
metadata = {
    "installedSha256": hashlib.sha256(Path("/etc/cron.d/fleet-backups").read_bytes()).hexdigest(),
    "beforeSha256": hashlib.sha256(text.encode()).hexdigest(),
    "proposedSha256": hashlib.sha256(proposed.encode()).hexdigest(),
    "rowSyntax": "bash -n passed for every executable cron row",
    "unchanged": "All cron schedules, locks, remote flags, health row, and weekly verify row preserved",
    "rows": rows,
    "applied": False,
}
assert metadata["installedSha256"] == metadata["beforeSha256"]
for name, contents in [("fleet-backups.proposed", proposed), ("fleet-backups.local-retention.patch", patch), ("fleet-backups.proposal.json", json.dumps(metadata, indent=2) + "\n")]:
    path = root / name
    path.write_text(contents)
    os.chmod(path, 0o600)
print(json.dumps(metadata, indent=2))
