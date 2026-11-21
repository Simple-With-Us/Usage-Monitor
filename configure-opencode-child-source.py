#!/usr/bin/env python3
# SUPERSEDED UNSAFE AUTOMATION DRAFT — DO NOT RUN.  It includes configuration and local-file writes.  Use opencode-child-source-plan.py for plan-only review; it has no apply path.
"""Guard one non-secret collector setting; credential values never leave custody."""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile

MODE = sys.argv[1] if len(sys.argv) > 1 else "plan"
if MODE not in ("plan", "apply"):
    raise SystemExit("Use plan or apply")
SOURCE = Path("/home/jay/.secrets/usage-monitor.env")
PLAN = Path(".um1646-opencode-config-plan.json")
KEY = "OPENCODE_ADDITIONAL_DBS_JSON"
INFISICAL_KEY = "OPENCODE_SERVER_ADDITIONAL_DBS_JSON"
REVIEWED_INSTALL_SHA = "pending-reviewed-merge"
VALUE = json.dumps(["/mnt/fleet-extra/apps/botfleet-server/home/.local/share/opencode/opencode.db"], separators=(",", ":"))
digest = lambda value: hashlib.sha256(value).hexdigest()
fd = os.open(SOURCE, os.O_RDONLY | os.O_NOFOLLOW)
with os.fdopen(fd, "rb") as handle:
    info = os.fstat(handle.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077:
        raise SystemExit("Unsafe existing collector configuration")
    raw = handle.read()
lines = raw.decode().splitlines(keepends=True)
matches = [i for i, line in enumerate(lines) if re.match(r"^(?:export\s+)?" + KEY + "=", line)]
if len(matches) > 1:
    raise SystemExit("Ambiguous existing setting")
if matches:
    existing = shlex.split(lines[matches[0]].split("=", 1)[1], comments=True)
    if existing != [VALUE]:
        raise SystemExit("Different existing source selection requires a new reviewed plan")
if MODE == "plan":
    plan = {"sourceSha256": digest(raw), "setting": KEY, "sourceOfTruthKey": INFISICAL_KEY, "additionalDatabaseCount": 1, "valueSha256": digest(VALUE.encode()), "alreadyConfigured": bool(matches), "primarySourcePreserved": True}
    data = (json.dumps(plan, sort_keys=True, indent=2) + "\n").encode()
    fd = os.open(PLAN, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as handle: handle.write(data)
    print(json.dumps({**plan, "planSha256": digest(data), "configurationChanged": False}))
    raise SystemExit(0)
data = PLAN.read_bytes()
if len(sys.argv) != 3 or digest(data) != sys.argv[2]:
    raise SystemExit("Exact reviewed configuration plan digest required")
plan = json.loads(data)
if plan["sourceSha256"] != digest(raw) or plan["valueSha256"] != digest(VALUE.encode()):
    raise SystemExit("Configuration changed since planning")
if not re.fullmatch(r"[a-f0-9]{40}", REVIEWED_INSTALL_SHA):
    raise SystemExit("Reviewed merged collector installation is required before activation")
installed = Path("/mnt/fleet-extra/apps/usage-monitor-collectors")
version_match = re.search(r"^sha=([a-f0-9]{7,40})$", (installed / "VERSION").read_text(), re.M)
if not version_match or not REVIEWED_INSTALL_SHA.startswith(version_match.group(1)):
    raise SystemExit("Installed collector revision differs from the reviewed merge")
expected = subprocess.run(["git", "show", REVIEWED_INSTALL_SHA + ":scripts/opencode-usage-collector.mjs"], capture_output=True, check=True).stdout
if digest((installed / "scripts/opencode-usage-collector.mjs").read_bytes()) != digest(expected):
    raise SystemExit("Installed collector entry does not match reviewed source")
backup = SOURCE.with_name(SOURCE.name + ".um-1646-before-opencode-source")
try:
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
except FileExistsError:
    fd = os.open(backup, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, "rb") as handle:
        if handle.read() != raw: raise SystemExit("Existing private backup differs; preserved")
else:
    os.fchown(fd, info.st_uid, info.st_gid)
    with os.fdopen(fd, "wb") as handle:
        handle.write(raw); handle.flush(); os.fsync(handle.fileno())
remote = r'''
import json, subprocess, urllib.request, urllib.error, urllib.parse
KEY=__KEY__
VALUE=__VALUE__
BASE='https://app.infisical.com'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect())
def fleet(name):
 p=subprocess.run(['fleet-secrets','get',name],capture_output=True,timeout=30)
 if p.returncode:raise RuntimeError('Scoped credential route unavailable')
 return p.stdout.decode().strip()
def request(url,method='GET',body=None,token=None):
 headers={'Content-Type':'application/json','User-Agent':'Fleet-Collector-Config/1'}
 if token:headers['Authorization']='Bearer '+token
 req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers=headers,method=method)
 try:
  with opener.open(req,timeout=25) as response:return response.status,json.load(response)
 except urllib.error.HTTPError as error:return error.code,{}
try:
 status,body=request(BASE+'/api/v1/auth/universal-auth/login','POST',{'clientId':fleet('INFISICAL_AUTOMATION_CLIENT_ID'),'clientSecret':fleet('INFISICAL_AUTOMATION_CLIENT_SECRET')})
 if status!=200:raise RuntimeError('Source-of-truth authentication failed')
 token=body['accessToken']
 params={'workspaceId':'86e35e51-91bc-4dfd-a045-4484726b9c40','environment':'prod','secretPath':'/telemetry','type':'shared'}
 url=BASE+'/api/v3/secrets/raw/'+KEY
 status,body=request(url+'?'+urllib.parse.urlencode(params),token=token)
 if status==200 and body['secret']['secretValue']!=VALUE:raise RuntimeError('Different existing source-of-truth setting preserved')
 created=status==404
 if status==404:
  status,body=request(url,'POST',{**params,'secretValue':VALUE},token)
  if status not in (200,201):raise RuntimeError('Source-of-truth creation refused')
 elif status!=200:raise RuntimeError('Source-of-truth read refused')
 status,body=request(url+'?'+urllib.parse.urlencode(params),token=token)
 if status!=200 or body['secret']['secretValue']!=VALUE:raise RuntimeError('Source-of-truth readback mismatch')
 print(json.dumps({'sourceOfTruthVerified':True,'sourceOfTruthCreated':created,'setting':KEY,'additionalDatabaseCount':1}))
except Exception as error:
 print(json.dumps({'sourceOfTruthVerified':False,'errorClass':type(error).__name__}))
 raise SystemExit(1)
'''.replace("__KEY__", repr(INFISICAL_KEY)).replace("__VALUE__", repr(VALUE))
proc = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "mac", "python3", "-"], input=remote.encode(), capture_output=True, timeout=120)
try: result = json.loads(proc.stdout)
except ValueError: raise SystemExit("Source-of-truth operation outcome unknown; inspect before retry")
if proc.returncode or result.get("sourceOfTruthVerified") is not True:
    print(json.dumps(result)); raise SystemExit(1)
if SOURCE.read_bytes() != raw:
    raise SystemExit("Source-of-truth verified; local configuration changed concurrently and was preserved")
addition = ("" if not raw or raw.endswith(b"\n") else "\n") + KEY + "=" + shlex.quote(VALUE) + "\n"
updated = raw if matches else raw + addition.encode()
fd, temp = tempfile.mkstemp(prefix=".um1646-source-", dir=SOURCE.parent)
try:
    os.fchmod(fd, stat.S_IMODE(info.st_mode))
    os.fchown(fd, info.st_uid, info.st_gid)
    with os.fdopen(fd, "wb") as handle:
        handle.write(updated); handle.flush(); os.fsync(handle.fileno())
    if SOURCE.read_bytes() != raw: raise RuntimeError("Concurrent local configuration change preserved")
    os.replace(temp, SOURCE)
finally:
    if os.path.exists(temp): os.unlink(temp)
if SOURCE.read_bytes() != updated: raise SystemExit("Local configuration readback mismatch")
print(json.dumps({**result, "localReadbackVerified": True, "unrelatedBytesPreserved": updated.startswith(raw), "primarySourcePreserved": True, "reloadPerformed": False}))
#!/usr/bin/env python3
# SUPERSEDED UNSAFE AUTOMATION DRAFT — DO NOT RUN.  It includes configuration and local-file writes.  Use opencode-child-source-plan.py for plan-only review; it has no apply path.
