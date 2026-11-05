#!/usr/bin/env python3
"""Serialized exact-main code deployment. Activation and credentials are external."""
import datetime, fnmatch, json, os, re, subprocess, sys, urllib.request
ACCOUNT = "3a9368057468d0909cafaa85df12d1b7"
TARGETS = json.load(open("scripts/worker-targets.json"))
# Cloudflare answers error 1010 (HTTP 403) to Python's default urllib User-Agent on
# the jays.services zones, so every request names this client explicitly.
USER_AGENT = "Usage-Monitor-worker-deploy/1.0"
# The message the account watchdog leaves on a Worker it stopped.  Re-arm is manual.
GUARD_TRIPPED = "GUARD-TRIPPED"
# A cron-only Worker has no route to call, so its probe reads the invocation analytics.
# Just under a day, so it spans two 12-hour auditor crons and stays inside a one-day query range.
TELEMETRY_WINDOW_SECONDS = 24*3600-60
TELEMETRY_OK_STATUSES = ("success","clientDisconnected","responseStreamDisconnected")
# Paths whose change can alter what a Worker deploy PUBLISHES.  Deliberately narrower than
# the push: paths: list in .github/workflows/worker-deploy.yml, which also includes test-only
# files so test changes still run the pipeline.  The push filter cannot cover the schedule and
# workflow_dispatch triggers, so worker_changed() applies this list to them.  The test in
# scripts/test-deploy-mapped-worker.py asserts every entry here stays in the workflow list.
WORKER_PATHS=["workers/**","scripts/deploy-mapped-worker.py",
  "scripts/worker-targets.json","scripts/infisical-fetch.mjs","scripts/verify-receipt-inbox-lifecycle.mjs",
  "package.json","package-lock.json",
  ".github/workflows/worker-deploy.yml"]
def worker_changed(live,target,cwd=None):
    """False only when git proves no deploy-relevant path differs between the live release and target.

    Any doubt (malformed tag, commit not in this checkout, diff failure) counts as changed:
    deploy, never wrongly skip."""
    if not re.fullmatch(r"[0-9a-f]{40}",live or ""):return True
    def git(*args):return subprocess.run(["git",*args],cwd=cwd,capture_output=True,text=True)
    if git("cat-file","-e",live+"^{commit}").returncode!=0:return True
    base=git("merge-base",live,target)
    if base.returncode!=0 or base.stdout.strip()!=live:return True
    diff=git("diff","--name-only","--no-renames","-z",live,target)
    if diff.returncode!=0:return True
    return any(fnmatch.fnmatchcase(p,g) for p in diff.stdout.split("\0") if p for g in WORKER_PATHS)
def api(path):
    request = urllib.request.Request("https://api.cloudflare.com/client/v4/accounts/" + ACCOUNT + path,
      headers={"Authorization":"Bearer " + os.environ["CLOUDFLARE_API_TOKEN"],"User-Agent":USER_AGENT})
    with urllib.request.urlopen(request, timeout=30) as response: body = json.load(response)
    if not body.get("success"): raise RuntimeError("Cloudflare read rejected")
    return body["result"]
def current_main():
    req=urllib.request.Request("https://api.github.com/repos/" + os.environ["GITHUB_REPOSITORY"] + "/git/ref/heads/main",
      headers={"Authorization":"Bearer " + os.environ["GH_TOKEN"],"Accept":"application/vnd.github+json","User-Agent":USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as response:return json.load(response)["object"]["sha"]
def live_version(name):
    """The version at 100% of production, or None for no deployment or a partial rollout."""
    deployments=api("/workers/scripts/"+name+"/deployments")["deployments"]
    if not deployments:return None
    versions=deployments[0].get("versions",[])
    if len(versions)!=1 or versions[0].get("percentage")!=100:return None
    return versions[0]["version_id"]
def live_annotations(name):
    """Annotations of the live version, then of each older one while the newer is secret-only.

    A secret change makes a new untagged version of the same code, so the code's release is
    the first version below it that is not secret-only.  That version must also be the one
    deployed before the secret change: after a rollback or an upload that was never deployed,
    the next lower number is not the code that was live, so the walk stops with no answer
    rather than a tag for code that is not running."""
    history=api("/workers/scripts/"+name+"/deployments")["deployments"]
    if not history:return
    versions=history[0].get("versions",[])
    if len(versions)!=1 or versions[0].get("percentage")!=100:return
    version=api("/workers/scripts/"+name+"/versions/"+versions[0]["version_id"])
    annotations=version.get("annotations") or {}
    yield annotations
    if annotations.get("workers/tag") or annotations.get("workers/triggered_by")!="secret":return
    number=version.get("number")
    if type(number) is not int:return
    passed={versions[0]["version_id"]}
    items=api("/workers/scripts/"+name+"/versions?per_page=50")["items"]
    earlier=[v for v in items if type(v.get("number")) is int and v["number"]<number]
    for item in sorted(earlier,key=lambda v:v["number"],reverse=True):
        annotations=item.get("annotations") or {}
        if annotations.get("workers/tag") or annotations.get("workers/triggered_by")!="secret":
            if item.get("id")==deployed_before(history,passed):yield annotations
            return
        yield annotations
        passed.add(item.get("id"))
def deployed_before(history,passed):
    """The version fully deployed just before the versions in passed, newest first."""
    for deployment in history:
        versions=deployment.get("versions",[])
        if len(versions)!=1 or versions[0].get("percentage")!=100:return None
        if versions[0]["version_id"] not in passed:return versions[0]["version_id"]
    return None
def deployed_tag(name):
    for annotations in live_annotations(name):
        if annotations.get("workers/tag"):return annotations["workers/tag"]
    return None
def guard_tripped(name):
    """True when the latest deployment or the release under it carries the watchdog's message."""
    deployments=api("/workers/scripts/"+name+"/deployments")["deployments"]
    messages=[(deployments[0].get("annotations") or {}).get("workers/message")] if deployments else []
    messages+=[a.get("workers/message") for a in live_annotations(name)]
    return any(str(m or "").startswith(GUARD_TRIPPED) for m in messages)
def refuse_if_tripped(name):
    if guard_tripped(name):
        raise SystemExit(name+" was stopped by the usage guard ("+GUARD_TRIPPED+"); deploying would undo the trip.  Re-arm by hand.")
def last_deployed_from(name):
    return api("/workers/services/"+name)["default_environment"]["script"].get("last_deployed_from")
def telemetry_rows(name):
    since=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(seconds=TELEMETRY_WINDOW_SECONDS)
    query="query($a:String!,$s:String!,$since:Time!){viewer{accounts(filter:{accountTag:$a}){workersInvocationsAdaptive(limit:1000,filter:{scriptName:$s,datetime_geq:$since}){sum{requests}dimensions{status scriptVersion}}}}}"
    payload={"query":query,"variables":{"a":ACCOUNT,"s":name,"since":since.strftime("%Y-%m-%dT%H:%M:%SZ")}}
    request=urllib.request.Request("https://api.cloudflare.com/client/v4/graphql",data=json.dumps(payload).encode(),
      headers={"Authorization":"Bearer "+os.environ["CLOUDFLARE_API_TOKEN"],"Content-Type":"application/json","User-Agent":USER_AGENT})
    with urllib.request.urlopen(request,timeout=30) as response:body=json.load(response)
    if body.get("errors"):raise RuntimeError("Cloudflare telemetry read rejected")
    return body["data"]["viewer"]["accounts"][0]["workersInvocationsAdaptive"]
def telemetry_probe(name,after_upload=False,before_upload=False):
    """No failed invocation on the live version, and the Worker has run recently.

    A version just uploaded has not met a cron yet, so right after upload only the first
    half applies; the next half-hour run of the job applies both.  Before an upload only the
    read has to work: this looks back a whole day, so one old failure of the live version
    would hold back the commit that fixes it for up to a day, and the inbox behind the auditor."""
    version=live_version(name)
    if not version:raise RuntimeError("Live version not at 100% for "+name)
    rows=telemetry_rows(name)
    failed=sum(r["sum"]["requests"] for r in rows
      if r["dimensions"]["scriptVersion"]==version and r["dimensions"]["status"] not in TELEMETRY_OK_STATUSES)
    if before_upload:
        if failed:print(str(failed)+" failed invocations on the live version of "+name+"; uploading the new version anyway")
        return
    if failed:raise RuntimeError(str(failed)+" failed invocations on the live version of "+name)
    if not after_upload and not sum(r["sum"]["requests"] for r in rows):
        raise RuntimeError("No invocations of "+name+" in the telemetry window")
def probe(target, name="unnamed target", after_upload=False, before_upload=False):
    if target.get("probe")=="telemetry":return telemetry_probe(name,after_upload,before_upload)
    url=target.get("health")
    if not url:raise RuntimeError("Functional probe not configured for "+name)
    headers={"User-Agent":USER_AGENT}
    if target.get("access"):
        headers["CF-Access-Client-Id"]=os.environ["WORKER_HEALTH_ACCESS_CLIENT_ID"]
        headers["CF-Access-Client-Secret"]=os.environ["WORKER_HEALTH_ACCESS_CLIENT_SECRET"]
    if target.get("bearer"):headers["Authorization"]="Bearer "+os.environ[target["bearer"]]
    request=urllib.request.Request(url,headers=headers)
    with urllib.request.urlopen(request,timeout=30) as response:
        if response.status!=200:raise RuntimeError("Health probe failed")
        data=json.load(response)
    if target.get("ok") and data.get("ok") is not True:raise RuntimeError("Health response not ready")
    if target.get("sections") and not isinstance(data.get("sections"),list):raise RuntimeError("Invalid sections response")
def main():
    name=sys.argv[1]
    if name not in TARGETS:raise SystemExit("Unknown mapped Worker")
    target=TARGETS[name]
    if not target.get("health") and target.get("probe")!="telemetry":raise SystemExit("No approved CI functional probe; activation blocked")
    sha=subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip()
    if current_main()!=sha:print("Superseded; skipping");return
    refuse_if_tripped(name)
    tag=deployed_tag(name)
    if tag==sha:probe(target,name);print("Already deployed and healthy");return
    if not worker_changed(tag,sha):probe(target,name);print("No Worker-relevant changes since "+tag[:12]+"; healthy, skipping");return
    # The inbox reads the auditor over a service binding, so the auditor must already be at this
    # code.  The matrix order normally ensures it; this also covers a failed auditor deploy.
    first=target.get("deploy_after")
    if first:
        first_tag=deployed_tag(first)
        if first_tag!=sha and worker_changed(first_tag,sha):
            raise SystemExit(first+" is not at "+sha[:12]+"; refusing to deploy "+name+" ahead of it")
    # Do not start a deployment unless probe credentials are present and old live service is healthy.
    # Fail closed: a live Worker that fails an HTTP probe is recovered by a manual deploy.  A
    # telemetry target only has to prove its read works here; see telemetry_probe.
    probe(target,name,before_upload=True)
    if name.startswith("usage-monitor-receipt-"):
        subprocess.run(["node","scripts/verify-receipt-inbox-lifecycle.mjs"],check=True)
    if current_main()!=sha:print("Superseded before upload; skipping");return
    refuse_if_tripped(name)
    flags=["--keep-vars","--tag",sha,"--message","main "+sha]
    # In CI, --strict aborts any Worker last changed through the script API, and a settings or
    # limits PATCH counts as that.  Git is the source of truth for those, and the limits check
    # keeps them in the config.  Dashboard edits (and anything else) still abort under --strict.
    if last_deployed_from(name)!="api":flags.insert(1,"--strict")
    subprocess.run([*target["command"],*flags],check=True,
                   env={**os.environ,"CLOUDFLARE_ACCOUNT_ID":ACCOUNT,"WRANGLER_SEND_METRICS":"false"})
    if deployed_tag(name)!=sha:raise RuntimeError("Exact version receipt does not match")
    probe(target,name,after_upload=True)
    print("Exact Worker version and functional probe verified: "+name+" "+sha)
if __name__=="__main__":main()
