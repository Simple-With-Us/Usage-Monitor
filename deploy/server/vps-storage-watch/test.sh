#!/bin/bash
# Test vps-storage-watch.sh against temporary files:  a database that grows past its 1-hour threshold posts one
# alert to #Alerts-Log › vps-storage that tags both Housekeepers and Jay, the cooldown holds the next pass, and a
# missing database path stops the run before anything is posted.
# usage: deploy/server/vps-storage-watch/test.sh
set -eu
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/bin" "$work/state"

# A curl stand-in that records each post's arguments instead of sending it.
cat > "$work/bin/curl" <<'EOF'
#!/bin/bash
printf '%s\n' "$@" > "$CURL_LOG.$(date +%s%N)"
EOF
chmod +x "$work/bin/curl"
printf 'email=operator@example.invalid\nkey=test-key\nsite=https://zulip.example.invalid\n' > "$work/zuliprc"
for db in st ct um; do : > "$work/$db.db"; done
cat > "$work/env" <<EOF
ST_APP_DB=$work/st.db
CT_DB=$work/ct.db
UM_DB=$work/um.db
EOF

run() {
  PATH="$work/bin:$PATH" CURL_LOG="$work/post" VPS_STORAGE_ENV="$1" VPS_STORAGE_STATE="$work/state" \
    VPS_STORAGE_ZULIPRC="$work/zuliprc" VPS_STORAGE_SNAPSHOT="$work/snapshot.json" VPS_STORAGE_DU_DIRS="$work" \
    bash "$here/vps-storage-watch.sh" > /dev/null
}
fail() { echo "FAIL: $*" >&2; exit 1; }
posts() { find "$work" -maxdepth 1 -name 'post.*' | wc -l; }

# A sample from two hours ago, then a CT database 200 MiB larger than it.
echo "$(( $(date +%s) - 7200 )) 0" > "$work/state/ct_db.samples"
truncate -s 200M "$work/ct.db"
run "$work/env"
[ "$(posts)" -eq 1 ] || fail "expected one post, got $(posts)"
post=$(cat "$work"/post.*)
grep -qx 'to=Alerts-Log' <<<"$post" || fail "not posted to #Alerts-Log"
grep -qx 'topic=vps-storage' <<<"$post" || fail "wrong topic"
grep -q 'ct_db growth SPIKE (1h)' <<<"$post" || fail "no spike title"
grep -qx '@\*\*BF-Housekeeper|1216054\*\* @\*\*GB-Housekeeper|1215533\*\* @\*\*Jay Wedgeworth|1211974\*\*' <<<"$post" \
  || fail "the mentions line is missing or wrong"
grep -q '"host": "' "$work/snapshot.json" || fail "no snapshot"

# The six-hour cooldown holds the next pass.
run "$work/env"
[ "$(posts)" -eq 1 ] || fail "the cooldown did not hold"

# A missing database path stops before any post.
rm -f "$work"/post.*
grep -v '^UM_DB=' "$work/env" > "$work/env.partial"
if run "$work/env.partial" 2>/dev/null; then fail "ran without UM_DB"; fi
[ "$(posts)" -eq 0 ] || fail "posted without UM_DB"

echo "vps-storage-watch: all checks passed"
