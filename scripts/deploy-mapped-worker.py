#!/usr/bin/env python3
"""Serialized exact-main code deployment. Activation and credentials are external."""
import json, os, subprocess, sys, urllib.request
ACCOUNT = "3a9368057468d0909cafaa85df12d1b7"
TARGETS = json.load(open("scripts/worker-targets.json"))
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
    if deployed_tag(name)==sha:probe(target,name);print("Already deployed and healthy");return
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
