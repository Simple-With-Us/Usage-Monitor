#!/usr/bin/env bash
# test-fixed-version.sh - the fixed-version shared four-digit build counter.
#
# Drives asc_next_shared_build() from ship-testflight.sh with a stub curl and
# a stub asc_client.  No network, no App Store Connect, no secrets:  the feed
# URLs are under example.invalid and are only ever handed to the stub.
#
# Pins the review rounds (Kody / Sentry):
#   1. the pairedBuildFeed curl is https-only and bounded (--proto/--proto-redir
#      =https, --connect-timeout 10, --max-time 30, --max-filesize 5000000)
#   2. a feed fetch failure logs the URL and curl's stderr, and a feed with no
#      numeric <sparkle:version> logs the URL and says so; both fail closed
#      (return 1, nothing on stdout, App Store Connect never called)
#   3. pairedBundleId is passed through to next-shared-build, macBundleId is an
#      accepted alias, and pairedBundleId wins when both are present
#   4. (round two) whitespace-padded <sparkle:version> values count, a non-https
#      feed is rejected before curl runs, a feed max outside 1..9998 fails
#      closed, and a macOS entry with no paired keys reverse-resolves its peer
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/ship-testflight.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fail() { echo "FAIL: $*" >&2; exit 1; }

# A registry with one entry per case.  The feed URLs are stubs-only.
cat > "${tmp}/apps.json" <<'APPS'
{
  "apps": {
    "feedok": {"bundleId": "test.feed.ok", "pairedBuildFeed": "https://example.invalid/appcast-ok.xml"},
    "feedfail": {"bundleId": "test.feed.fail", "pairedBuildFeed": "https://example.invalid/appcast-fail.xml"},
    "feedempty": {"bundleId": "test.feed.empty", "pairedBuildFeed": "https://example.invalid/appcast-empty.xml"},
    "pairednew": {"bundleId": "test.paired.ios", "pairedBundleId": "test.paired.mac"},
    "pairedalias": {"bundleId": "test.alias.ios", "macBundleId": "test.alias.mac"},
    "pairedboth": {"bundleId": "test.both.ios", "pairedBundleId": "test.both.new", "macBundleId": "test.both.old"},
    "nopair": {"bundleId": "test.nopair.ios"},
    "macentry": {"bundleId": "test.mac.app", "platform": "macOS", "pairedBundleId": "test.ios.app"},
    "feedpaired": {"bundleId": "test.fp.ios", "pairedBundleId": "test.fp.mac", "pairedBuildFeed": "https://example.invalid/appcast-fp.xml"},
    "feedws": {"bundleId": "test.feed.ws", "pairedBuildFeed": "https://example.invalid/appcast-ws.xml"},
    "feedhttp": {"bundleId": "test.feed.http", "pairedBuildFeed": "http://example.invalid/appcast-ok.xml"},
    "feedbig": {"bundleId": "test.feed.big", "pairedBuildFeed": "https://example.invalid/appcast-big.xml"},
    "feedzero": {"bundleId": "test.feed.zero", "pairedBuildFeed": "https://example.invalid/appcast-zero.xml"},
    "iosrev": {"bundleId": "test.rev.ios", "pairedBundleId": "test.rev.mac"},
    "macrev": {"bundleId": "test.rev.mac", "platform": "macOS"},
    "maclonely": {"bundleId": "test.lonely.mac", "platform": "macOS"}
  }
}
APPS

# An appcast whose max numeric <sparkle:version> is 1400.
cat > "${tmp}/appcast-ok.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<rss><channel>
<item><title>1.0 (1399)</title><sparkle:version>1399</sparkle:version></item>
<item><title>1.0 (1400)</title><sparkle:version>1400</sparkle:version></item>
</channel></rss>
XML
# An appcast with no numeric <sparkle:version> at all.
cat > "${tmp}/appcast-empty.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<rss><channel>
<item><title>1.0</title><sparkle:version>1.0</sparkle:version></item>
</channel></rss>
XML
# An appcast whose max (1400) is padded with whitespace; a tab-padded 1398 and
# a plain 1399 sit below it.
printf '%s\n' '<?xml version="1.0" encoding="utf-8"?>' \
  '<rss><channel>' \
  '<item><title>1.0 (1399)</title><sparkle:version>1399</sparkle:version></item>' \
  '<item><title>1.0 (1398)</title><sparkle:version>	1398	</sparkle:version></item>' \
  '<item><title>1.0 (1400)</title><sparkle:version>  1400  </sparkle:version></item>' \
  '</channel></rss>' > "${tmp}/appcast-ws.xml"
# An appcast whose max cannot yield a four-digit build (9999 + 1 overflows).
cat > "${tmp}/appcast-big.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<rss><channel>
<item><title>1.0 (1400)</title><sparkle:version>1400</sparkle:version></item>
<item><title>1.0 (9999)</title><sparkle:version>9999</sparkle:version></item>
</channel></rss>
XML
# An appcast whose max is below the 1..9998 feed range.
cat > "${tmp}/appcast-zero.xml" <<'XML'
<?xml version="1.0" encoding="utf-8"?>
<rss><channel>
<item><title>1.0 (0)</title><sparkle:version>0</sparkle:version></item>
</channel></rss>
XML

# Stub curl: records its argv, then answers from files or fails like a timeout.
mkdir -p "${tmp}/bin"
cat > "${tmp}/bin/curl" <<'CURL'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$CURL_ARGS_LOG"
if [[ "${CURL_MODE:-ok}" == "fail" ]]; then
  printf '%s\n' "${CURL_STDERR:-curl: (7) Failed to connect}" >&2
  exit "${CURL_RC:-7}"
fi
cat "$CURL_BODY_FILE"
exit 0
CURL
chmod +x "${tmp}/bin/curl"
export PATH="${tmp}/bin:${PATH}"
export CURL_ARGS_LOG="${tmp}/curl.log"
export CURL_BODY_FILE="${tmp}/appcast-ok.xml"
: > "$CURL_ARGS_LOG"

extract() {
  awk '
    /^json_get\(\) \{/ || /^asc_credential_available\(\) \{/ || /^asc_next_shared_build\(\) \{/ { grab = 1 }
    grab { print }
    grab && /^\}/ { grab = 0 }
  ' "$script"
}

funcs="${tmp}/funcs.sh"
{
  echo 'logerr() { echo "[ios-ship] $*" >&2; }'
  echo "APPS_JSON=\"${tmp}/apps.json\""
  echo 'ASC_NODE="node"'
  echo 'APP_KEY=""'
  echo 'BUNDLE_ID=""'
  echo "ASC_ARGS_LOG=\"${tmp}/asc.log\""
  cat <<'FUNCS'
asc_client() {
  printf '%s\n' "$@" >> "$ASC_ARGS_LOG"
  printf '1501'
  return 0
}
FUNCS
  extract
} > "$funcs"
grep -q '^asc_next_shared_build()' "$funcs" || fail "asc_next_shared_build not found in ship-testflight.sh"
grep -q '^json_get()' "$funcs" || fail "json_get not found in ship-testflight.sh"
# shellcheck disable=SC1090
source "$funcs"

# Dummy credential names so the real asc_credential_available passes without
# any secret material and without touching the network.
export ASC_KEY_ID=test-key ASC_ISSUER_ID=test-issuer ASC_KEY_P8=test-pem
export ASC_ARGS_LOG="${tmp}/asc.log"

reset_logs() { : > "$CURL_ARGS_LOG"; : > "$ASC_ARGS_LOG"; : > "${tmp}/err"; }

# 1. The feed curl is https-only and bounded and carries the URL; the appcast
# max joins as a floor.
reset_logs
export APP_KEY=feedok BUNDLE_ID=test.feed.ok CURL_MODE=ok CURL_BODY_FILE="${tmp}/appcast-ok.xml"
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 0 ]] || fail "feed-ok run failed (rc=${rc}): $(cat "${tmp}/err")"
[[ "$out" == "1501" ]] || fail "feed-ok run printed '${out}' instead of the client answer"
grep -qF -- '--connect-timeout' "$CURL_ARGS_LOG" || fail "curl was not passed --connect-timeout"
grep -qF -- '10' "$CURL_ARGS_LOG" || fail "curl was not passed --connect-timeout 10"
grep -qF -- '--max-time' "$CURL_ARGS_LOG" || fail "curl was not passed --max-time"
grep -qF -- '30' "$CURL_ARGS_LOG" || fail "curl was not passed --max-time 30"
grep -qF 'https://example.invalid/appcast-ok.xml' "$CURL_ARGS_LOG" || fail "curl was not passed the feed URL"
grep -qF -- '-fsSL' "$CURL_ARGS_LOG" || fail "curl lost its -fsSL flags"
grep -qF -- '--proto' "$CURL_ARGS_LOG" || fail "curl was not passed --proto"
grep -qF -- '--proto-redir' "$CURL_ARGS_LOG" || fail "curl was not passed --proto-redir"
grep -qF -- '=https' "$CURL_ARGS_LOG" || fail "curl was not restricted to https"
grep -qF -- '--max-filesize' "$CURL_ARGS_LOG" || fail "curl was not passed --max-filesize"
grep -qF -- '5000000' "$CURL_ARGS_LOG" || fail "curl was not passed --max-filesize 5000000"
[[ "$(cat "$ASC_ARGS_LOG")" == "$(printf 'next-shared-build\ntest.feed.ok\n1400')" ]] \
  || fail "the appcast max 1400 did not reach the client as a floor: $(tr '\n' ' ' < "$ASC_ARGS_LOG")"

# 1b. The hardened fetch is in the ship script text itself, not just observed once.
grep -qF 'curl -fsSL --proto =https --proto-redir =https --connect-timeout 10 --max-time 30 --max-filesize 5000000 "$feed"' "$script" \
  || fail "ship-testflight.sh does not harden the feed curl"
# 1c. The feed max is not computed by a hardcoded interpreter.
helper_body="$(awk '/^asc_next_shared_build\(\) \{/ {grab = 1} grab {print} grab && /^\}/ {grab = 0}' "$script")"
[[ -n "$helper_body" ]] || fail "could not read asc_next_shared_build from ship-testflight.sh"
if grep -qF '/usr/bin/python3' <<<"$helper_body"; then
  fail "asc_next_shared_build calls /usr/bin/python3 (resolve python3 via PATH or use POSIX tools)"
fi

# 2. A feed timeout fails closed: return 1, nothing on stdout, the URL and
# curl's stderr on stderr, and App Store Connect never called.
reset_logs
export APP_KEY=feedfail BUNDLE_ID=test.feed.fail CURL_MODE=fail CURL_RC=28
export CURL_STDERR="curl: (28) Operation timed out after 30000 milliseconds"
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 1 ]] || fail "feed timeout did not fail closed (rc=${rc})"
[[ -z "$out" ]] || fail "feed timeout printed on stdout: ${out}"
grep -qF 'https://example.invalid/appcast-fail.xml' "${tmp}/err" || fail "feed timeout did not log the URL"
grep -qF 'timed out' "${tmp}/err" || fail "feed timeout did not log curl stderr"
if grep -q 'App Store Connect' "${tmp}/err"; then fail "feed timeout was reported as an App Store Connect failure"; fi
[[ ! -s "$ASC_ARGS_LOG" ]] || fail "feed timeout still called App Store Connect"

# 3. A feed with no numeric <sparkle:version> fails closed and says so with the URL.
reset_logs
export APP_KEY=feedempty BUNDLE_ID=test.feed.empty CURL_MODE=ok CURL_BODY_FILE="${tmp}/appcast-empty.xml"
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 1 ]] || fail "version-less feed did not fail closed (rc=${rc})"
[[ -z "$out" ]] || fail "version-less feed printed on stdout: ${out}"
grep -qF 'https://example.invalid/appcast-empty.xml' "${tmp}/err" || fail "version-less feed did not log the URL"
grep -qF 'no numeric <sparkle:version>' "${tmp}/err" || fail "version-less feed did not say so"
if grep -q 'App Store Connect' "${tmp}/err"; then fail "version-less feed was reported as an App Store Connect failure"; fi
[[ ! -s "$ASC_ARGS_LOG" ]] || fail "version-less feed still called App Store Connect"

# 4. pairedBundleId is passed through as the paired app.
reset_logs
export APP_KEY=pairednew BUNDLE_ID=test.paired.ios CURL_MODE=ok
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 0 && "$out" == "1501" ]] || fail "pairedBundleId run failed (rc=${rc} out=${out})"
[[ "$(cat "$ASC_ARGS_LOG")" == "$(printf 'next-shared-build\ntest.paired.ios\ntest.paired.mac')" ]] \
  || fail "pairedBundleId was not passed through: $(tr '\n' ' ' < "$ASC_ARGS_LOG")"

# 5. macBundleId is kept as an alias for the paired app.
reset_logs
export APP_KEY=pairedalias BUNDLE_ID=test.alias.ios
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 0 && "$out" == "1501" ]] || fail "macBundleId run failed (rc=${rc} out=${out})"
[[ "$(cat "$ASC_ARGS_LOG")" == "$(printf 'next-shared-build\ntest.alias.ios\ntest.alias.mac')" ]] \
  || fail "macBundleId was not passed through: $(tr '\n' ' ' < "$ASC_ARGS_LOG")"

# 6. pairedBundleId wins when both keys are present.
reset_logs
export APP_KEY=pairedboth BUNDLE_ID=test.both.ios
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 0 && "$out" == "1501" ]] || fail "both-keys run failed (rc=${rc} out=${out})"
[[ "$(cat "$ASC_ARGS_LOG")" == "$(printf 'next-shared-build\ntest.both.ios\ntest.both.new')" ]] \
  || fail "pairedBundleId did not win over macBundleId: $(tr '\n' ' ' < "$ASC_ARGS_LOG")"

# 7. No paired keys and no feed: the client gets the bundle id only.
reset_logs
export APP_KEY=nopair BUNDLE_ID=test.nopair.ios
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 0 && "$out" == "1501" ]] || fail "no-pair run failed (rc=${rc} out=${out})"
[[ "$(cat "$ASC_ARGS_LOG")" == "$(printf 'next-shared-build\ntest.nopair.ios')" ]] \
  || fail "no-pair run passed unexpected args: $(tr '\n' ' ' < "$ASC_ARGS_LOG")"

# 8. A macOS entry names the iOS bundle id as its pair; it passes through too.
reset_logs
export APP_KEY=macentry BUNDLE_ID=test.mac.app
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 0 && "$out" == "1501" ]] || fail "macOS-entry run failed (rc=${rc} out=${out})"
[[ "$(cat "$ASC_ARGS_LOG")" == "$(printf 'next-shared-build\ntest.mac.app\ntest.ios.app')" ]] \
  || fail "macOS pairedBundleId was not passed through: $(tr '\n' ' ' < "$ASC_ARGS_LOG")"

# 9. Paired app plus feed floor reach the client together, in order.
reset_logs
export APP_KEY=feedpaired BUNDLE_ID=test.fp.ios CURL_BODY_FILE="${tmp}/appcast-ok.xml"
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 0 && "$out" == "1501" ]] || fail "paired-plus-feed run failed (rc=${rc} out=${out})"
[[ "$(cat "$ASC_ARGS_LOG")" == "$(printf 'next-shared-build\ntest.fp.ios\ntest.fp.mac\n1400')" ]] \
  || fail "paired id and floor did not reach the client in order: $(tr '\n' ' ' < "$ASC_ARGS_LOG")"

# 10. Whitespace-padded <sparkle:version> values count; the padded max joins.
reset_logs
export APP_KEY=feedws BUNDLE_ID=test.feed.ws CURL_MODE=ok CURL_BODY_FILE="${tmp}/appcast-ws.xml"
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 0 && "$out" == "1501" ]] || fail "whitespace feed run failed (rc=${rc} out=${out}): $(cat "${tmp}/err")"
[[ "$(cat "$ASC_ARGS_LOG")" == "$(printf 'next-shared-build\ntest.feed.ws\n1400')" ]] \
  || fail "the padded appcast max 1400 did not reach the client as a floor: $(tr '\n' ' ' < "$ASC_ARGS_LOG")"

# 11. A non-https feed is rejected before curl runs: return 1, the URL logged,
# curl never called, App Store Connect never called.
reset_logs
export APP_KEY=feedhttp BUNDLE_ID=test.feed.http CURL_MODE=ok CURL_BODY_FILE="${tmp}/appcast-ok.xml"
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 1 ]] || fail "non-https feed did not fail closed (rc=${rc})"
[[ -z "$out" ]] || fail "non-https feed printed on stdout: ${out}"
grep -qF 'http://example.invalid/appcast-ok.xml' "${tmp}/err" || fail "non-https feed did not log the URL"
[[ ! -s "$CURL_ARGS_LOG" ]] || fail "non-https feed still ran curl"
[[ ! -s "$ASC_ARGS_LOG" ]] || fail "non-https feed still called App Store Connect"

# 12. A feed max above 9998 fails closed with the URL; nothing reaches the client.
reset_logs
export APP_KEY=feedbig BUNDLE_ID=test.feed.big CURL_MODE=ok CURL_BODY_FILE="${tmp}/appcast-big.xml"
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 1 ]] || fail "out-of-range feed max did not fail closed (rc=${rc})"
[[ -z "$out" ]] || fail "out-of-range feed max printed on stdout: ${out}"
grep -qF 'https://example.invalid/appcast-big.xml' "${tmp}/err" || fail "out-of-range feed max did not log the URL"
[[ ! -s "$ASC_ARGS_LOG" ]] || fail "out-of-range feed max still called App Store Connect"

# 12b. A feed max below 1 fails closed the same way.
reset_logs
export APP_KEY=feedzero BUNDLE_ID=test.feed.zero CURL_MODE=ok CURL_BODY_FILE="${tmp}/appcast-zero.xml"
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 1 ]] || fail "zero feed max did not fail closed (rc=${rc})"
[[ -z "$out" ]] || fail "zero feed max printed on stdout: ${out}"
grep -qF 'https://example.invalid/appcast-zero.xml' "${tmp}/err" || fail "zero feed max did not log the URL"
[[ ! -s "$ASC_ARGS_LOG" ]] || fail "zero feed max still called App Store Connect"

# 13. A macOS entry with no paired keys reverse-resolves its peer: the iOS
# entry naming this bundle id joins the counter.
reset_logs
export APP_KEY=macrev BUNDLE_ID=test.rev.mac CURL_MODE=ok
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 0 && "$out" == "1501" ]] || fail "macOS reverse-lookup run failed (rc=${rc} out=${out}): $(cat "${tmp}/err")"
[[ "$(cat "$ASC_ARGS_LOG")" == "$(printf 'next-shared-build\ntest.rev.mac\ntest.rev.ios')" ]] \
  || fail "macOS reverse lookup did not pass the iOS peer: $(tr '\n' ' ' < "$ASC_ARGS_LOG")"

# 14. A macOS entry with no peer anywhere ships with the bundle id only.
reset_logs
export APP_KEY=maclonely BUNDLE_ID=test.lonely.mac CURL_MODE=ok
set +e
out="$(asc_next_shared_build 2>"${tmp}/err")"; rc=$?
set -e
[[ $rc -eq 0 && "$out" == "1501" ]] || fail "lonely macOS run failed (rc=${rc} out=${out})"
[[ "$(cat "$ASC_ARGS_LOG")" == "$(printf 'next-shared-build\ntest.lonely.mac')" ]] \
  || fail "lonely macOS run passed unexpected args: $(tr '\n' ' ' < "$ASC_ARGS_LOG")"

echo "ok: fixed-version shared build (hardened feed fetch, feed failures fail closed with the URL, pairing with macOS reverse lookup)"
