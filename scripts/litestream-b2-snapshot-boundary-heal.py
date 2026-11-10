"""UM Litestream B2 L1 heal (fleet precedent: ST 2026-08-22 unwedge).

Reads the UM container's LITESTREAM_S3_* env in-process (never printed), then:
  --inventory  (default) list per-level object counts + dry-run delete plan
  --apply      delete L1 (0001/) objects whose maxTXID < newest snapshot maxTXID

The delete set is a strict PREFIX of L1 already superseded by the newest
snapshot-level object, so the remaining L1 chain stays contiguous and the
restore window (newest snapshot + later LTX) is untouched.  Never touches
level 0000 (L0), the snapshot level, or any other prefix/bucket.
"""
import json
import subprocess
import sys

import boto3

UM = "yagelvqux9e8l1kztif7bf2o-055626515293"
APPLY = "--apply" in sys.argv

# Secrets are injected by Infisical at runtime, so docker Config.Env lacks them —
# read the live litestream process environ via the HOST /proc (ST 2026-08-22 method).
# Several fleet apps run litestream on this box — pick the process whose env
# names the UM bucket, never any other app's.
pids = subprocess.run(
    ["pgrep", "-f", "litestream replicate"],
    capture_output=True, text=True,
).stdout.split()
env = {}
for cand in pids:
    try:
        raw_env = open("/proc/%s/environ" % cand, "rb").read()
    except OSError:
        continue
    cand_env = {}
    for e in raw_env.split(b"\0"):
        k, _, v = e.partition(b"=")
        if k:
            cand_env[k.decode(errors="replace")] = v.decode(errors="replace")
    if cand_env.get("LITESTREAM_S3_BUCKET") == "jays-usage-monitor-eu":
        env = cand_env
        break
assert env, "no litestream process with the UM bucket found"

bucket = env.get("LITESTREAM_S3_BUCKET")
endpoint = env.get("LITESTREAM_S3_ENDPOINT")
region = env.get("LITESTREAM_S3_REGION")
ak = env.get("LITESTREAM_S3_ACCESS_KEY_ID")
sk = env.get("LITESTREAM_S3_SECRET_ACCESS_KEY")
assert bucket == "jays-usage-monitor-eu", "unexpected bucket: %s" % bucket
assert endpoint and "backblazeb2.com" in endpoint, "unexpected endpoint"

s3 = boto3.client(
    "s3",
    endpoint_url=endpoint,
    region_name=region,
    aws_access_key_id=ak,
    aws_secret_access_key=sk,
)

prefix = "api-usage-monitor/prod.db/"
levels = {}
paginator = s3.get_paginator("list_objects_v2")
for page in paginator.paginate(Bucket=bucket, Prefix=prefix):
    for obj in page.get("Contents", []):
        key = obj["Key"]
        rel = key[len(prefix):]
        parts = rel.split("/")
        if len(parts) != 2:
            levels.setdefault("other", []).append((rel, obj["Size"]))
            continue
        levels.setdefault(parts[0], []).append((parts[1], obj["Size"]))

for lvl in sorted(levels):
    items = levels[lvl]
    names = sorted(n for n, _ in items)
    total = sum(s for _, s in items)
    print("level %s: %d objects, %.1f MB, first=%s last=%s"
          % (lvl, len(items), total / 1e6, names[0][:44], names[-1][:44]))

# The failing "level=1" compaction reads the L0 (0000/) set as input; reader 14
# is the 14th L0 object.  The newest L9 snapshot embeds everything up to its
# maxTXID, so every object (at any compaction level) wholly below that boundary
# is superseded for restore purposes and safe to delete.
l0 = sorted(n for n, _ in levels.get("0000", []))
if len(l0) >= 14:
    print("L0 file #14 (suspected corrupt):", l0[13])

if "0009" not in levels:
    print("NO L9 snapshot found — ABORTING plan (nothing safe to key off).")
    sys.exit(2)
snaps = sorted(n for n, _ in levels["0009"])
newest = snaps[-1]
smax = newest.split("-")[1].split(".")[0]
print("newest L9 snapshot: %s (maxTXID %s)" % (newest, smax))

doomed = []  # (level, name)
for lvl in ("0000", "0001", "0002", "0003"):
    for name in sorted(n for n, _ in levels.get(lvl, [])):
        if name.split("-")[1].split(".")[0] < smax:
            doomed.append((lvl, name))

keep_l0 = [n for n in l0 if n.split("-")[1].split(".")[0] >= smax]
# Contiguity of the kept L0 suffix (single-txid files, hex names).
gaps = 0
for a, b in zip(keep_l0, keep_l0[1:]):
    if int(b.split("-")[0], 16) != int(a.split("-")[1].split(".")[0], 16) + 1:
        gaps += 1
dsize = sum(s for lvl in ("0000", "0001", "0002", "0003")
            for n, s in levels.get(lvl, []) if (lvl, n) in set(doomed))
print("PLAN: delete %d objects (%.1f MB) below snapshot boundary %s; keep %d L0, %d gaps in kept suffix"
      % (len(doomed), dsize / 1e6, smax, len(keep_l0), gaps))
covers14 = len(l0) >= 14 and ("0000", l0[13]) in set(doomed)
print("suspected-corrupt file included in delete set:", covers14)

if not APPLY:
    print("DRY RUN ONLY — re-run with --apply to delete.")
    sys.exit(0)

if not covers14 or len(keep_l0) < 50 or gaps != 0:
    print("SAFETY ABORT: corrupt file not covered, too few L0 kept, or kept suffix has gaps.")
    sys.exit(3)

deleted = 0
batch = []
for lvl, name in doomed:
    batch.append({"Key": prefix + lvl + "/" + name})
    if len(batch) == 1000:
        s3.delete_objects(Bucket=bucket, Delete={"Objects": batch, "Quiet": True})
        deleted += len(batch)
        batch = []
        print("deleted %d/%d..." % (deleted, len(doomed)))
if batch:
    s3.delete_objects(Bucket=bucket, Delete={"Objects": batch, "Quiet": True})
    deleted += len(batch)
print("APPLIED: deleted %d objects below snapshot boundary." % deleted)
