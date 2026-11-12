#!/usr/bin/env python3
"""Limits and registry check for this repo's Workers.  Local form of the fleet's check-worker-guards.

Fails when a tracked wrangler config is missing from scripts/worker-targets.json, a registry
entry has no valid guard, a config's limits exceed the registry ceiling or a config has no
explicit log sampling.  wrangler sends limits only when the config has them, so a config
without limits could drop the live ones on deploy.  A registry entry may set limits_pending
while the config change lands elsewhere; that is only a notice here, and --require-limits
(the deploy job) refuses it.
"""
import json
import pathlib
import sys

STATUSES = {"auto", "gated", "frozen", "retire"}
LIMITS = {"cpu_ms": "max_cpu_ms", "subrequests": "max_subrequests"}


def parse_jsonc(text):
    """Parse JSON with comments and trailing commas, leaving string contents alone."""
    out = []
    i = 0
    in_string = False
    while i < len(text):
        c = text[i]
        if in_string:
            out.append(c)
            if c == "\\":
                out.append(text[i + 1])
                i += 1
            elif c == '"':
                in_string = False
        elif c == '"':
            in_string = True
            out.append(c)
        elif text.startswith("//", i):
            end = text.find("\n", i)
            i = len(text) if end < 0 else end
            continue
        elif text.startswith("/*", i):
            end = text.find("*/", i)
            if end < 0:
                raise ValueError("unterminated comment")
            i = end + 2
            continue
        else:
            if c in "}]":
                j = len(out) - 1
                while j >= 0 and out[j].isspace():
                    j -= 1
                if j >= 0 and out[j] == ",":
                    del out[j]
            out.append(c)
        i += 1
    return json.loads("".join(out))


def is_positive_int(value):
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def config_path(target):
    command = target.get("command") or []
    if "--config" not in command or command.index("--config") + 1 >= len(command):
        return None
    return command[command.index("--config") + 1]


def check_limits(name, config, guard, require_limits):
    errors, notices = [], []
    limits = config.get("limits") or {}
    for key, ceiling_key in LIMITS.items():
        value = limits.get(key)
        ceiling = guard.get(ceiling_key)
        if value is None:
            if guard.get("limits_pending") and not require_limits:
                notices.append(f"{name}: limits.{key} pending in its wrangler config")
            else:
                errors.append(f"{name}: wrangler config has no limits.{key}")
        elif not is_positive_int(value):
            errors.append(f"{name}: limits.{key} must be a positive integer")
        elif is_positive_int(ceiling) and value > ceiling:
            errors.append(f"{name}: limits.{key} {value} is over the registry ceiling {ceiling}")
    return errors, notices


def check(root=".", require_limits=False):
    """Return (errors, notices) for the registry and every wrangler config under workers/."""
    root = pathlib.Path(root)
    targets = json.loads((root / "scripts/worker-targets.json").read_text())
    errors, notices = [], []
    registered = {}
    for name, target in targets.items():
        guard = target.get("guard")
        if not isinstance(guard, dict):
            errors.append(f"{name}: registry entry has no guard")
            continue
        if guard.get("status") not in STATUSES:
            errors.append(f"{name}: guard status must be one of {sorted(STATUSES)}")
        for ceiling_key in LIMITS.values():
            if not is_positive_int(guard.get(ceiling_key)):
                errors.append(f"{name}: guard {ceiling_key} must be a positive integer")
        path = config_path(target)
        if not path or not (root / path).is_file():
            errors.append(f"{name}: registry entry names no existing wrangler config")
            continue
        registered[(root / path).resolve()] = name
    found = [
        p for p in sorted((root / "workers").rglob("wrangler.*"))
        if "node_modules" not in p.parts and ".wrangler" not in p.parts
    ]
    for path in found:
        label = path.relative_to(root).as_posix()
        if path.suffix not in {".json", ".jsonc"}:
            errors.append(f"{label}: only wrangler.json and wrangler.jsonc are checked")
            continue
        try:
            config = parse_jsonc(path.read_text())
        except ValueError as exc:
            errors.append(f"{label}: cannot parse ({exc})")
            continue
        name = config.get("name")
        if name not in targets:
            errors.append(f"{label}: Worker {name!r} is not in scripts/worker-targets.json")
            continue
        if registered.get(path.resolve()) != name:
            errors.append(f"{label}: Worker {name!r} is mapped to a different config")
            continue
        limit_errors, limit_notices = check_limits(name, config, targets[name]["guard"], require_limits)
        errors += limit_errors
        notices += limit_notices
        if (config.get("observability") or {}).get("head_sampling_rate") is None:
            errors.append(f"{name}: observability has no explicit head_sampling_rate")
    return errors, notices


def main(argv):
    errors, notices = check(require_limits="--require-limits" in argv)
    for line in notices:
        print("notice: " + line)
    for line in errors:
        print("error: " + line)
    if errors:
        return 1
    print("Worker guards ok")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
