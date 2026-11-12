"""Prepare a private same-service upgrade plan; never mutate the running service."""
import hashlib
import base64
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request
import yaml

if len(sys.argv) != 2 or not re.fullmatch(r"[a-f0-9]{40}", sys.argv[1]):
    raise SystemExit("One exact reviewed merged commit is required")
target = sys.argv[1]
root = Path("/tmp/um1646-ops")
routing = json.loads((root / "hub-routing.json").read_text())
service = json.loads((root / "hub-service.json").read_text())

def run(args):
    p = subprocess.run(args, capture_output=True, text=True, timeout=40)
    if p.returncode:
        raise RuntimeError("Approved read operation failed")
    return p.stdout

def sha(value):
    return hashlib.sha256(value).hexdigest()

def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None

opener = urllib.request.build_opener(NoRedirect())
if routing["base_url"] not in ("http://100.69.77.26:8000/api/v1", "https://host.jays.services/api/v1"):
    raise SystemExit("Approved Coolify route changed")
token = run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "mac", "fleet-secrets get COOLIFY_AGENTS"]).strip()
if not token:
    raise SystemExit("Approved Coolify route unavailable")
request = urllib.request.Request(routing["base_url"] + "/services/" + service["uuid"], headers={"Authorization": "Bearer " + token, "Accept": "application/json"})
with opener.open(request, timeout=25) as response:
    current = json.load(response)
compose = yaml.safe_load(current.get("docker_compose") or current.get("docker_compose_raw"))
unit = compose["services"]["telemetry-hub"]
raw_value = current.get('docker_compose_raw')
if not isinstance(raw_value, str) or not raw_value:
    raise SystemExit('Original raw compose is unavailable; preserve the service')
raw_compose = yaml.safe_load(raw_value)
if not isinstance(raw_compose, dict):
    try:
        raw_compose = yaml.safe_load(base64.b64decode(raw_value, validate=True).decode())
    except Exception:
        raise SystemExit('Original raw compose shape is unsupported')
if not isinstance(raw_compose, dict) or set(raw_compose.get('services', {})) != {'telemetry-hub'}:
    raise SystemExit('Original raw compose service membership changed')
raw_unit = raw_compose['services']['telemetry-hub']
if os.environ.get('UM1651_RAW_SHAPE_ONLY') == '1':
    raw_env = raw_unit.get('environment', {})
    if isinstance(raw_env, list): raw_env = dict(item.split('=', 1) for item in raw_env if '=' in item)
    prepared = json.loads((root / 'hub-compose.json').read_text())
    print(json.dumps({'rawSourceAvailable': True, 'rawEnvironmentKeyNames': sorted(raw_env), 'rawEqualsRetainedPreparedCompose': raw_compose == prepared, 'rawImageMatchesRecord': raw_unit.get('image') == 'usage-monitor-telemetry-hub:' + service['source_commit'], 'rawAndGeneratedVolumeKeysEqual': set(raw_compose.get('volumes', {})) == set(compose.get('volumes', {})), 'rawDataMountCount': sum('/data' in str(v) for v in raw_unit.get('volumes', [])), 'rawConfigMountCount': sum(isinstance(v, dict) and v.get('target') == '/run/secrets/telemetry-hub.json' for v in raw_unit.get('volumes', []))}))
    raise SystemExit(0)
if raw_unit.get('image') != 'usage-monitor-telemetry-hub:' + service['source_commit'] or raw_unit.get('network_mode') != 'host' or raw_unit.get('ports') or raw_unit.get('networks') or raw_unit.get('read_only') is not True:
    raise SystemExit('Raw service invariants changed')
env = unit.get("environment", {})
if isinstance(env, list):
    env = dict(item.split("=", 1) for item in env if "=" in item)
if os.environ.get("UM1651_PLAN_SHAPE_ONLY") == "1":
    print(json.dumps({"environmentKeyNames": sorted(env), "configFileMatches": env.get("TELEMETRY_HUB_CONFIG_FILE") == "/run/secrets/telemetry-hub.json", "bindMatches": env.get("TELEMETRY_HUB_BIND_HOST") == routing["tailnet_bind"], "hostNetwork": unit.get("network_mode") == "host", "portsPresent": bool(unit.get("ports")), "networksPresent": bool(unit.get("networks")), "imageMatches": unit.get("image") == "usage-monitor-telemetry-hub:" + service["source_commit"], "readOnly": unit.get("read_only"), "readOnlyType": type(unit.get("read_only")).__name__, "serviceKeys": sorted(unit)}))
    raise SystemExit(0)
generated_keys = {"COOLIFY_APP_NAME", "COOLIFY_CONTAINER_NAME", "COOLIFY_ENVIRONMENT_NAME", "COOLIFY_PROJECT_NAME", "COOLIFY_RESOURCE_UUID", "COOLIFY_SERVER_IP", "SERVICE_NAME_TELEMETRY_HUB"}
if (
    set(env) != {"TELEMETRY_HUB_CONFIG_FILE", "TELEMETRY_HUB_BIND_HOST"} | generated_keys
    or env["TELEMETRY_HUB_CONFIG_FILE"] != "/run/secrets/telemetry-hub.json"
    or env["TELEMETRY_HUB_BIND_HOST"] != routing["tailnet_bind"]
    or env.get("COOLIFY_RESOURCE_UUID") != service["uuid"]
    or unit.get("network_mode") != "host"
    or unit.get("ports") or unit.get("networks")
    or unit.get("image") != "usage-monitor-telemetry-hub:" + service["source_commit"]
    or unit.get("read_only") is not True
):
    raise SystemExit("Live service shape differs; inspect without changing it")
new_image = "usage-monitor-telemetry-hub:" + target
new = json.loads(run(["docker", "image", "inspect", new_image]))[0]
if new.get("Config", {}).get("Labels", {}).get("org.opencontainers.image.revision") != target:
    raise SystemExit("Reviewed target image is unavailable")
ids = run(["docker", "ps", "--filter", "ancestor=" + unit["image"], "--format", "{{.ID}}"]).splitlines()
if len(ids) != 1:
    raise SystemExit("Expected one active original hub")
container = json.loads(run(["docker", "inspect", ids[0]]))[0]
if container["Config"].get("Labels", {}).get("org.opencontainers.image.revision") != service["source_commit"]:
    raise SystemExit("Original runtime revision changed")
container_env = dict(item.split('=', 1) for item in container['Config'].get('Env', []) if '=' in item)
if container_env.get('COOLIFY_RESOURCE_UUID') != service['uuid']:
    raise SystemExit('Local runtime is not the verified Coolify service')
names = {entry.split("=", 1)[0] for entry in container["Config"].get("Env", [])}
if any(name.startswith(("SENTRY_", "INFISICAL_")) or name in {"TELEMETRY_HUB_SOURCES_JSON", "USAGE_INGEST_TOKEN"} for name in names):
    raise SystemExit("Static runtime credential bindings changed")
mounts = container["Mounts"]
volume = [m for m in mounts if m.get("Destination") == "/data" and m.get("Type") == "volume"]
config = [m for m in mounts if m.get("Destination") == "/run/secrets/telemetry-hub.json" and m.get("Type") == "bind" and not m.get("RW")]
baseline_volume_hash = json.loads((root / 'hub-runtime-before-restart.json').read_text()).get('volume_hash')
if os.environ.get('UM1651_MOUNT_SHAPE_ONLY') == '1':
    print(json.dumps({'dataVolumeCount': len(volume), 'configBindCount': len(config), 'dataMountTypes': [m.get('Type') for m in mounts if m.get('Destination') == '/data'], 'configMountTypes': [m.get('Type') for m in mounts if m.get('Destination') == '/run/secrets/telemetry-hub.json'], 'configReadOnly': [not m.get('RW') for m in mounts if m.get('Destination') == '/run/secrets/telemetry-hub.json'], 'baselineVolumeHashAvailable': isinstance(baseline_volume_hash, str), 'volumeMatchesRetainedReceipt': len(volume) == 1 and sha(volume[0].get('Name', '').encode()) == baseline_volume_hash}))
    raise SystemExit(0)
if len(volume) != 1 or sha(volume[0].get("Name", "").encode()) != baseline_volume_hash or len(config) != 1:
    raise SystemExit("Durable volume or read-only configuration changed")
if container["State"].get("Health", {}).get("Status") != "healthy" or not container["HostConfig"].get("ReadonlyRootfs"):
    raise SystemExit("Original hub is not healthy and read-only")
script = r"""const fs=require('node:fs'),crypto=require('node:crypto');
const cfg='/run/secrets/telemetry-hub.json',st=fs.statSync(cfg);
const base=JSON.parse(fs.readFileSync('/data/state/journal.base.json'));
const offset=JSON.parse(fs.readFileSync('/data/state/sentry.offset.json')).offset;
const bytes=fs.statSync('/data/journal.jsonl').size;
if(base.pendingSize!==0||!Number.isSafeInteger(base.base)||!Number.isSafeInteger(offset)||offset>base.base+bytes)throw Error('Unsafe journal snapshot');
console.log(JSON.stringify({configSha256:crypto.createHash('sha256').update(fs.readFileSync(cfg)).digest('hex'),configUid:st.uid,configMode:st.mode&511,journalBase:base.base,journalBytes:bytes,sentryOffset:offset,pendingBytes:base.base+bytes-offset}));"""
metadata = json.loads(run(["docker", "exec", ids[0], "node", "-e", script]))
if metadata["configUid"] != 10001 or metadata["configMode"] != 0o600:
    raise SystemExit("Configuration custody mode changed")
if metadata["configSha256"] != "4de53644a6cfc8bc79af1c2f7da1b6b52c1db19fbd8bc806920e30ce6b671579":
    raise SystemExit("Reserved configuration snapshot changed")
plan = {
    "mode": "plan-only", "targetCommit": target, "targetImageId": new["Id"],
    "service": service, "serviceStatus": current.get("status"),
    "oldContainer": ids[0], "oldImageId": container["Image"],
    "currentCompose": compose, "currentComposeSha256": sha(canonical(compose)),
    "rawCompose": raw_compose, "rawComposeSha256": sha(canonical(raw_compose)),
    "preparedComposeSha256": sha((root / "hub-compose.json").read_bytes()),
    "metadata": metadata, "durableVolume": volume[0]["Name"],
    "configMountSource": config[0]["Source"],
    "upgradeContract": "Build before stop; recheck live compose/image/config and zero pending bytes before one stop; preserve current compose except image/telemetry.commit; same service/volume/config; inspect unknown outcomes before any retry",
    "runtimeChanges": False,
}
path = Path(".um1651-hub-upgrade-" + target + ".plan.json")
data = json.dumps(plan, sort_keys=True, indent=2).encode() + b"\n"
fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, "wb") as handle:
    handle.write(data)
    handle.flush()
    os.fsync(handle.fileno())
print(json.dumps({"plan": str(path), "planSha256": sha(data), "targetCommit": target, "oldCommit": service["source_commit"], "pendingBytes": metadata["pendingBytes"], "runtimeChanges": False}))
