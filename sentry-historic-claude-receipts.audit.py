import json
import math
import re
import subprocess
import urllib.parse
import urllib.request
import urllib.error


START = "2026-10-29T05:00:00Z"
END = "2026-10-31T05:00:00Z"
EVENTS_PATH = "/api/0/organizations/simple-with-us/events/"


auth = subprocess.run(
    ["fleet-secrets", "get", "SENTRY_ADMIN"],
    capture_output=True,
    text=True,
    timeout=30,
)
if auth.returncode:
    raise SystemExit("Approved Sentry read route unavailable")
token = auth.stdout.strip()
if not token:
    raise SystemExit("Approved Sentry read route unavailable")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


opener = urllib.request.build_opener(NoRedirect())


def get(url):
    parsed = urllib.parse.urlparse(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "sentry.io"
        or parsed.username
        or parsed.password
    ):
        raise SystemExit("Untrusted Sentry query target")
    request = urllib.request.Request(
        url,
        headers={"Authorization": "Bearer " + token, "Accept": "application/json"},
    )
    with opener.open(request, timeout=30) as response:
        return json.load(response), response.headers


project, _ = get("https://sentry.io/api/0/projects/simple-with-us/agent-sessions/")
project_id = str(project.get("id", ""))
if not project_id.isdigit():
    raise SystemExit("Sentry project identity unavailable")


def safe_label(value):
    if value is None:
        return None
    if isinstance(value, str) and len(value) <= 160 and re.fullmatch(r"[a-zA-Z0-9._:/@+-]*", value):
        return value
    raise ValueError("Invalid aggregate label")


for dataset in ("spans", "logs"):
    params = [
        ("dataset", dataset),
        ("project", project_id),
        ("field", "agent.platform"),
        ("field", "service.name"),
        ("field", "count()"),
        ("start", START),
        ("end", END),
        ("per_page", "100"),
        (
            "query",
            "agent.platform:claude-code service.name:telemetry-hub* "
            "!gen_ai.request.model:telemetry-verification*",
        ),
    ]
    url = "https://sentry.io" + EVENTS_PATH + "?" + urllib.parse.urlencode(params)
    totals = {}
    pages = 0
    try:
        while url:
            result, headers = get(url)
            data = result.get("data") if isinstance(result, dict) else None
            if not isinstance(data, list):
                raise ValueError("Invalid aggregate response")
            for row in data:
                count = row.get("count()")
                platform = safe_label(row.get("agent.platform"))
                source = safe_label(row.get("service.name"))
                if (
                    isinstance(count, bool)
                    or not isinstance(count, (int, float))
                    or not math.isfinite(count)
                    or count < 0
                    or platform != "claude-code"
                    or not isinstance(source, str)
                    or not source.startswith("telemetry-hub")
                ):
                    raise ValueError("Invalid aggregate row")
                totals[(platform, source)] = totals.get((platform, source), 0) + count
            pages += 1
            next_url = None
            for link in headers.get("Link", "").split(","):
                if 'rel="next"' in link and 'results="true"' in link:
                    match = re.search(r"<([^>]+)>", link)
                    if match:
                        next_url = match.group(1)
            if next_url:
                parsed = urllib.parse.urlparse(next_url)
                next_params = urllib.parse.parse_qs(parsed.query)
                if (
                    parsed.path != EVENTS_PATH
                    or parsed.hostname != "sentry.io"
                    or next_params.get("project") != [project_id]
                    or next_params.get("start") != [START]
                    or next_params.get("end") != [END]
                    or next_params.get("dataset") != [dataset]
                ):
                    raise ValueError("Invalid pagination target")
            url = next_url
            if pages >= 10 and url:
                raise ValueError("Receipt pagination bound reached")
        rows = [
            {"platform": platform, "source": source, "count": count}
            for (platform, source), count in sorted(totals.items())
        ]
        print(json.dumps({"dataset": dataset, "start": START, "end": END, "rows": rows, "complete": True}))
    except urllib.error.HTTPError as error:
        print(json.dumps({"dataset": dataset, "start": START, "end": END, "http_status": error.code, "complete": False}))
    except Exception as error:
        print(json.dumps({"dataset": dataset, "start": START, "end": END, "error_type": type(error).__name__, "complete": False}))
