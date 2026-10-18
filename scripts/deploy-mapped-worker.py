#!/usr/bin/env python3
"""Serialized exact-main code deployment. Activation and credentials are external."""
import fnmatch, json, os, re, subprocess, sys, urllib.request
ACCOUNT = "3a9368057468d0909cafaa85df12d1b7"
TARGETS = json.load(open("scripts/worker-targets.json"))
# Paths whose change can alter what a Worker deploy publishes.  Keep this list identical
# to the push: paths: list in .github/workflows/worker-deploy.yml.  The push filter cannot
# cover the schedule and workflow_dispatch triggers, so worker_changed() applies it to them.
WORKER_PATHS=["workers/**","scripts/deploy-mapped-worker.py","scripts/test-deploy-mapped-worker.py",
  "scripts/worker-targets.json","scripts/infisical-fetch.mjs","scripts/verify-receipt-inbox-lifecycle.mjs",
  "package.json","package-lock.json","vitest.config.ts","vitest.setup.ts",
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
      headers={"Authorization":"Bearer " + os.environ["CLOUDFLARE_API_TOKEN"]})
    with urllib.request.urlopen(request, timeout=30) as response: body = json.load(response)
    if not body.get("success"): raise RuntimeError("Cloudflare read rejected")
    return body["result"]
def current_main():
    req=urllib.request.Request("https://api.github.com/repos/" + os.environ["GITHUB_REPOSITORY"] + "/git/ref/heads/main",
      headers={"Authorization":"Bearer " + os.environ["GH_TOKEN"],"Accept":"application/vnd.github+json"})
    with urllib.request.urlopen(req, timeout=30) as response:return json.load(response)["object"]["sha"]
def deployed_tag(name):
    deployments=api("/workers/scripts/"+name+"/deployments")["deployments"]
    if not deployments:return None
    versions=deployments[0].get("versions",[])
    if len(versions)!=1 or versions[0].get("percentage")!=100:return None
    v=api("/workers/scripts/"+name+"/versions/"+versions[0]["version_id"])
    return v.get("annotations",{}).get("workers/tag")
def probe(target, name="unnamed target"):
    url=target.get("health")
    if not url:raise RuntimeError("Functional probe not configured for "+name)
    headers={}
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
    if not target.get("health"):raise SystemExit("No approved CI functional probe; activation blocked")
    sha=subprocess.check_output(["git","rev-parse","HEAD"],text=True).strip()
    if current_main()!=sha:print("Superseded; skipping");return
    tag=deployed_tag(name)
    if tag==sha:probe(target,name);print("Already deployed and healthy");return
    if not worker_changed(tag,sha):probe(target,name);print("No Worker-relevant changes since "+tag[:12]+"; healthy, skipping");return
    # Do not start a deployment unless probe credentials are present and old live service is healthy.
    # Fail closed: a live Worker that fails this probe is recovered by a manual deploy or rollback.
    probe(target,name)
    if name.startswith("usage-monitor-receipt-"):
        subprocess.run(["node","scripts/verify-receipt-inbox-lifecycle.mjs"],check=True)
    if current_main()!=sha:print("Superseded before upload; skipping");return
    subprocess.run([*target["command"],"--keep-vars","--strict","--tag",sha,"--message","main "+sha],check=True,
                   env={**os.environ,"CLOUDFLARE_ACCOUNT_ID":ACCOUNT,"WRANGLER_SEND_METRICS":"false"})
    if deployed_tag(name)!=sha:raise RuntimeError("Exact version receipt does not match")
    probe(target,name)
    print("Exact Worker version and functional probe verified: "+name+" "+sha)
if __name__=="__main__":main()
