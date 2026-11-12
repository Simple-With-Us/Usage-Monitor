import json
import os
import time


root = os.path.expanduser("~/.claude/projects")
result = {
    "root_exists": os.path.isdir(root),
    "complete": True,
    "jsonl_files": 0,
    "total_bytes": 0,
    "oldest_age_hours": None,
    "newest_age_hours": None,
}

if result["root_exists"]:
    now = time.time()
    mtimes = []
    stack = [root]
    visited = 0
    while stack:
        directory = stack.pop()
        try:
            entries = list(os.scandir(directory))
        except OSError:
            result["complete"] = False
            continue
        for entry in entries:
            visited += 1
            if visited > 100000:
                result["complete"] = False
                stack.clear()
                break
            try:
                if entry.is_dir(follow_symlinks=False):
                    stack.append(entry.path)
                elif entry.name.endswith(".jsonl") and entry.is_file(follow_symlinks=False):
                    stat = entry.stat(follow_symlinks=False)
                    result["jsonl_files"] += 1
                    result["total_bytes"] += stat.st_size
                    mtimes.append(stat.st_mtime)
            except OSError:
                result["complete"] = False
    if mtimes:
        result["oldest_age_hours"] = round(max(0, (now - min(mtimes)) / 3600), 1)
        result["newest_age_hours"] = round(max(0, (now - max(mtimes)) / 3600), 1)

print(json.dumps(result, sort_keys=True))
