#!/usr/bin/env python3
"""Run one explicitly selected, plan-bound telemetry hub upgrade phase."""

from __future__ import annotations

import argparse
import base64
import copy
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import shutil
import socket
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

import yaml


OPS_ROOT = Path("/tmp/um1646-ops")
IMAGE_NAME = "usage-monitor-telemetry-hub"
REVISION_LABEL = "org.opencontainers.image.revision"
MAX_PRIVATE_JSON = 4 * 1024 * 1024
HTTP_TIMEOUT_SECONDS = 25
COMMAND_TIMEOUT_SECONDS = 35
POSTCONDITION_TIMEOUT_SECONDS = 20
POSTCONDITION_POLL_SECONDS = 2
STOPPED_STATUSES = {"exited", "stopped", "degraded:unhealthy"}
STARTED_STATUSES = {"running", "healthy", "running:healthy"}
METADATA_KEYS = {
    "configSha256", "configUid", "configMode", "journalBase",
    "journalBytes", "sentryOffset", "pendingBytes",
}


class PhaseFailure(Exception):
    """A sanitized refusal containing a reason code only."""


def fail(reason: str) -> PhaseFailure:
    return PhaseFailure(reason)


def _sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _open_private(path: Path) -> tuple[int, os.stat_result]:
    try:
        before = os.lstat(path)
    except OSError:
        raise fail("private_file_unavailable") from None
    if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.getuid()
            or stat.S_IMODE(before.st_mode) != 0o600
            or before.st_size < 0 or before.st_size > MAX_PRIVATE_JSON):
        raise fail("private_file_metadata_invalid")
    flags = (os.O_RDONLY | getattr(os, "O_CLOEXEC", 0) | getattr(os, "O_NOFOLLOW", 0)
             | getattr(os, "O_NONBLOCK", 0))
    try:
        fd = os.open(path, flags)
    except OSError:
        raise fail("private_file_open_failed") from None
    opened = os.fstat(fd)
    if (not stat.S_ISREG(opened.st_mode) or opened.st_dev != before.st_dev
            or opened.st_ino != before.st_ino or opened.st_uid != before.st_uid
            or opened.st_size != before.st_size or opened.st_mtime_ns != before.st_mtime_ns
            or stat.S_IMODE(opened.st_mode) != 0o600):
        os.close(fd)
        raise fail("private_file_changed")
    return fd, before


def _read_private(path: Path) -> bytes:
    fd, before = _open_private(path)
    try:
        chunks: list[bytes] = []
        remaining = MAX_PRIVATE_JSON + 1
        while remaining:
            chunk = os.read(fd, min(64 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after_fd = os.fstat(fd)
        after_path = os.lstat(path)
        if (len(data) > MAX_PRIVATE_JSON or len(data) != before.st_size
                or after_fd.st_dev != before.st_dev or after_fd.st_ino != before.st_ino
                or after_fd.st_size != before.st_size or after_fd.st_mtime_ns != before.st_mtime_ns
                or after_path.st_dev != before.st_dev or after_path.st_ino != before.st_ino
                or after_path.st_size != before.st_size or after_path.st_mtime_ns != before.st_mtime_ns):
            raise fail("private_file_changed")
        return data
    finally:
        os.close(fd)


def _write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        size = os.write(fd, view)
        if size <= 0:
            raise fail("private_write_failed")
        view = view[size:]


def _write_exclusive(path: Path, value: dict[str, object]) -> None:
    payload = json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8") + b"\n"
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_CLOEXEC", 0)
    flags |= getattr(os, "O_NOFOLLOW", 0)
    try:
        fd = os.open(path, flags, 0o600)
    except OSError:
        raise fail("phase_record_exists_or_unavailable") from None
    try:
        os.fchmod(fd, 0o600)
        os.fchown(fd, os.getuid(), os.getgid())
        _write_all(fd, payload)
        os.fsync(fd)
    finally:
        os.close(fd)
    parent_fd = os.open(path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def _plan(path: Path, claimed_sha: str) -> tuple[dict[str, object], str]:
    data = _read_private(path)
    digest = _sha(data)
    if digest != claimed_sha:
        raise fail("plan_sha256_mismatch")
    try:
        value = json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise fail("plan_json_invalid") from None
    if not isinstance(value, dict) or value.get("mode") != "plan-only" or value.get("runtimeChanges") is not False:
        raise fail("plan_shape_invalid")
    target = value.get("targetCommit")
    service = value.get("service")
    if (not isinstance(target, str) or not re.fullmatch(r"[a-f0-9]{40}", target)
            or not isinstance(service, dict)
            or not isinstance(service.get("uuid"), str)
            or not re.fullmatch(r"[a-z0-9]{24}", service["uuid"])
            or not isinstance(service.get("source_commit"), str)
            or not re.fullmatch(r"[a-f0-9]{40}", service["source_commit"])):
        raise fail("plan_identity_invalid")
    raw_compose = value.get("rawCompose")
    if (not isinstance(raw_compose, dict)
            or _sha(_canonical(raw_compose)) != value.get("rawComposeSha256")):
        raise fail("plan_raw_compose_hash_invalid")
    if (not isinstance(value.get("targetImageId"), str)
            or not isinstance(value.get("oldContainer"), str)
            or not isinstance(value.get("oldImageId"), str)
            or not isinstance(value.get("durableVolume"), str)
            or not isinstance(value.get("configMountSource"), str)
            or not isinstance(value.get("metadata"), dict)
            or set(value["metadata"]) != METADATA_KEYS):
        raise fail("plan_runtime_metadata_invalid")
    if set(raw_compose.get("services", {})) != {"telemetry-hub"}:
        raise fail("plan_service_membership_invalid")
    unit = raw_compose["services"]["telemetry-hub"]
    if (not isinstance(unit, dict)
            or unit.get("image") != f"{IMAGE_NAME}:{service['source_commit']}"
            or unit.get("network_mode") != "host"
            or unit.get("read_only") is not True
            or unit.get("ports") or unit.get("networks")):
        raise fail("plan_original_service_invariants_invalid")
    labels = unit.get("labels")
    if not isinstance(labels, dict) or labels.get("telemetry.commit") != service["source_commit"]:
        raise fail("plan_commit_label_invalid")
    return value, digest


def _load_routing() -> tuple[str, str]:
    try:
        routing = json.loads((OPS_ROOT / "hub-routing.json").read_bytes())
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        raise fail("routing_inventory_unavailable") from None
    base_url = routing.get("base_url") if isinstance(routing, dict) else None
    bind = routing.get("tailnet_bind") if isinstance(routing, dict) else None
    if base_url not in ("http://100.69.77.26:8000/api/v1", "https://host.jays.services/api/v1"):
        raise fail("coolify_route_not_approved")
    try:
        ipaddress.ip_address(bind)
    except (ValueError, TypeError):
        raise fail("private_bind_invalid") from None
    return base_url, bind


def _coolify_token() -> str:
    try:
        result = subprocess.run(
            ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "mac",
             "fleet-secrets", "get", "COOLIFY_AGENTS"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=30, check=False,
        )
    except OSError as error:
        raise fail(type(error).__name__) from None
    except subprocess.TimeoutExpired:
        raise fail("credential_route_timeout") from None
    if result.returncode:
        raise fail("credential_route_failed")
    try:
        token = result.stdout.decode("utf-8", "strict").strip()
    except UnicodeDecodeError:
        raise fail("credential_encoding_invalid") from None
    if not token:
        raise fail("credential_unavailable")
    return token


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class _Coolify:
    def __init__(self, base_url: str, token: str, service_uuid: str):
        if not re.fullmatch(r"[a-z0-9]{24}", service_uuid):
            raise fail("service_uuid_invalid")
        self._base = base_url
        self._token = token
        self._service_path = "/services/" + service_uuid
        self._opener = urllib.request.build_opener(_NoRedirect())

    def request(self, suffix: str = "", *, method: str = "GET",
                payload: dict[str, object] | None = None,
                timeout: float = HTTP_TIMEOUT_SECONDS) -> object:
        if (method, suffix) not in {
            ("GET", ""), ("PATCH", ""),
            ("POST", "/stop?docker_cleanup=false"), ("POST", "/start"),
        }:
            raise fail("coolify_path_not_allowed")
        if (method == "PATCH") != (payload is not None):
            raise fail("coolify_payload_not_allowed")
        body = None if payload is None else json.dumps(payload, separators=(",", ":")).encode()
        if body is not None and set(payload) != {"docker_compose_raw", "instant_deploy"}:
            raise fail("coolify_payload_shape_invalid")
        request = urllib.request.Request(
            self._base + self._service_path + suffix,
            data=body,
            headers={"Authorization": "Bearer " + self._token,
                     "Accept": "application/json", "Content-Type": "application/json"},
            method=method,
        )
        try:
            with self._opener.open(request, timeout=timeout) as response:
                data = response.read(MAX_PRIVATE_JSON + 1)
                if len(data) > MAX_PRIVATE_JSON:
                    raise fail("coolify_response_too_large")
                return json.loads(data)
        except (OSError, urllib.error.URLError, urllib.error.HTTPError) as error:
            raise fail(type(error).__name__) from None
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise fail("coolify_response_invalid") from None


def _docker_binary() -> str:
    path = shutil.which("docker")
    if not path:
        raise fail("docker_unavailable")
    return path


def _docker(args: list[str], *, check: bool = True,
            timeout: float = COMMAND_TIMEOUT_SECONDS) -> bytes:
    try:
        result = subprocess.run(
            [_docker_binary(), *args], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            timeout=timeout, check=False,
        )
    except subprocess.TimeoutExpired:
        raise fail("docker_command_timeout") from None
    except OSError as error:
        raise fail(type(error).__name__) from None
    if check and result.returncode:
        raise fail("docker_command_failed")
    return result.stdout


def _docker_json(args: list[str], *, timeout: float = COMMAND_TIMEOUT_SECONDS) -> object:
    data = _docker(args, timeout=timeout)
    try:
        return json.loads(data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise fail("docker_json_invalid") from None


def _image_identity(plan: dict[str, object]) -> None:
    target = plan["targetCommit"]
    image = f"{IMAGE_NAME}:{target}"
    inspect = _docker_json(["image", "inspect", image])
    if not isinstance(inspect, list) or len(inspect) != 1:
        raise fail("target_image_missing_or_ambiguous")
    item = inspect[0]
    if (item.get("Id") != plan["targetImageId"]
            or item.get("Config", {}).get("Labels", {}).get(REVISION_LABEL) != target):
        raise fail("target_image_identity_changed")


def _parse_raw_compose(service: object) -> dict[str, object]:
    if not isinstance(service, dict):
        raise fail("service_response_invalid")
    raw = service.get("docker_compose_raw")
    if not isinstance(raw, str) or not raw:
        raise fail("raw_compose_missing")
    try:
        parsed = yaml.safe_load(raw)
    except yaml.YAMLError:
        parsed = None
    if isinstance(parsed, str):
        parsed = None
    if not isinstance(parsed, dict):
        try:
            decoded = base64.b64decode(raw, validate=True).decode("utf-8")
            parsed = yaml.safe_load(decoded)
        except Exception:
            raise fail("raw_compose_invalid") from None
    if not isinstance(parsed, dict):
        raise fail("raw_compose_invalid")
    return parsed


def _service_view(api: _Coolify, plan: dict[str, object],
                  expected: dict[str, object] | None = None,
                  timeout: float = HTTP_TIMEOUT_SECONDS) -> tuple[dict[str, object], dict[str, object]]:
    response, compose = _live_service_compose(api, plan, timeout=timeout)
    comparison = plan["rawCompose"] if expected is None else expected
    expected_hash = plan["rawComposeSha256"] if expected is None else _sha(_canonical(expected))
    if _sha(_canonical(compose)) != expected_hash or compose != comparison:
        raise fail("live_raw_compose_compare_failed")
    return response, compose


def _live_service_compose(api: _Coolify, plan: dict[str, object],
                          *, timeout: float = HTTP_TIMEOUT_SECONDS) -> tuple[dict[str, object], dict[str, object]]:
    response = api.request(timeout=timeout)
    if not isinstance(response, dict):
        raise fail("service_response_invalid")
    if response.get("uuid") != plan["service"]["uuid"]:
        raise fail("live_service_identity_mismatch")
    compose = _parse_raw_compose(response)
    return response, compose


def _target_image_revision(plan: dict[str, object], image: dict[str, object]) -> bool:
    labels = image.get("Config", {}).get("Labels", {})
    return labels.get(REVISION_LABEL) == plan["targetCommit"]


def _running_ids(image_ref: str, *, timeout: float = COMMAND_TIMEOUT_SECONDS) -> list[str]:
    data = _docker(["ps", "--filter", "ancestor=" + image_ref, "--format", "{{.ID}}"],
                   timeout=timeout)
    return [line.strip() for line in data.decode("utf-8", "strict").splitlines() if line.strip()]


def _container(container_id: str, *, timeout: float = COMMAND_TIMEOUT_SECONDS) -> dict[str, object]:
    data = _docker_json(["inspect", container_id], timeout=timeout)
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        raise fail("container_inspect_invalid")
    return data[0]


def _validate_mounts(container: dict[str, object], plan: dict[str, object]) -> None:
    mounts = container.get("Mounts")
    if not isinstance(mounts, list):
        raise fail("container_mounts_invalid")
    data = [m for m in mounts if isinstance(m, dict) and m.get("Destination") == "/data"]
    config = [m for m in mounts if isinstance(m, dict)
              and m.get("Destination") == "/run/secrets/telemetry-hub.json"]
    if (len(data) != 1 or data[0].get("Type") != "volume"
            or data[0].get("Name") != plan["durableVolume"]
            or len(config) != 1 or config[0].get("Type") != "bind"
            or config[0].get("Source") != plan["configMountSource"]
            or config[0].get("RW") is not False):
        raise fail("container_mount_compare_failed")


def _validate_container_identity(container: dict[str, object], plan: dict[str, object],
                                 *, target: bool, bind_host: str) -> None:
    image = container.get("Config", {}).get("Image")
    expected_ref = f"{IMAGE_NAME}:{plan['targetCommit']}" if target else f"{IMAGE_NAME}:{plan['service']['source_commit']}"
    expected_image_id = plan["targetImageId"] if target else plan["oldImageId"]
    expected_revision = plan["targetCommit"] if target else plan["service"]["source_commit"]
    config = container.get("Config", {})
    labels = config.get("Labels", {})
    env = {}
    for item in config.get("Env", []):
        if isinstance(item, str) and "=" in item:
            key, value = item.split("=", 1)
            env[key] = value
    host_config = container.get("HostConfig", {})
    user_uid = str(config.get("User", "")).split(":", 1)[0]
    if (image != expected_ref or container.get("Image") != expected_image_id
            or labels.get(REVISION_LABEL) != expected_revision
            or env.get("COOLIFY_RESOURCE_UUID") != plan["service"]["uuid"]
            or env.get("TELEMETRY_HUB_CONFIG_FILE") != "/run/secrets/telemetry-hub.json"
            or env.get("TELEMETRY_HUB_BIND_HOST") != bind_host
            or user_uid != "10001"
            or host_config.get("ReadonlyRootfs") is not True
            or host_config.get("NetworkMode") != "host"
            or bool(host_config.get("PortBindings"))
            or any(key.startswith(("SENTRY_", "INFISICAL_"))
                   or key in {"TELEMETRY_HUB_SOURCES_JSON", "USAGE_INGEST_TOKEN"} for key in env)):
        raise fail("container_identity_or_static_env_invalid")
    _validate_mounts(container, plan)


def _metadata_script() -> str:
    return r"""const fs=require('node:fs'),crypto=require('node:crypto');
const cfg='/run/secrets/telemetry-hub.json',st=fs.statSync(cfg);
const base=JSON.parse(fs.readFileSync('/data/state/journal.base.json'));
const offset=JSON.parse(fs.readFileSync('/data/state/sentry.offset.json')).offset;
const bytes=fs.statSync('/data/journal.jsonl').size;
if(base.pendingSize!==0||!Number.isSafeInteger(base.base)||base.base<0||!Number.isSafeInteger(offset)||offset<base.base||offset>base.base+bytes)throw Error('Unsafe journal snapshot');
console.log(JSON.stringify({configSha256:crypto.createHash('sha256').update(fs.readFileSync(cfg)).digest('hex'),configUid:st.uid,configMode:st.mode&511,journalBase:base.base,journalBytes:bytes,sentryOffset:offset,pendingBytes:base.base+bytes-offset}));"""


def _runtime_metadata(container_id: str, *, timeout: float = COMMAND_TIMEOUT_SECONDS) -> dict[str, object]:
    output = _docker(["exec", container_id, "node", "-e", _metadata_script()], timeout=timeout)
    try:
        value = json.loads(output)
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise fail("runtime_metadata_invalid") from None
    if (not isinstance(value, dict) or set(value) != METADATA_KEYS
            or not isinstance(value["configSha256"], str)
            or not re.fullmatch(r"[a-f0-9]{64}", value["configSha256"])
            or any(not isinstance(value[key], int) or isinstance(value[key], bool)
                   for key in METADATA_KEYS - {"configSha256"})):
        raise fail("runtime_metadata_shape_invalid")
    return value


def _check_metadata_against_plan(actual: dict[str, object], plan: dict[str, object], *, before_stop: bool) -> None:
    baseline = plan["metadata"]
    for key in ("configSha256", "configUid", "configMode"):
        if actual[key] != baseline[key]:
            raise fail("runtime_config_compare_failed")
    if actual["configUid"] != 10001 or actual["configMode"] != 0o600:
        raise fail("runtime_config_custody_invalid")
    if before_stop:
        if actual["pendingBytes"] != 0:
            raise fail("journal_pending_bytes_nonzero")
        for key in ("journalBase", "journalBytes", "sentryOffset", "pendingBytes"):
            if actual[key] != baseline[key]:
                raise fail("journal_source_compare_failed")


def _old_runtime(plan: dict[str, object], bind_host: str) -> tuple[str, dict[str, object], dict[str, object]]:
    image_ref = f"{IMAGE_NAME}:{plan['service']['source_commit']}"
    ids = _running_ids(image_ref)
    if ids != [plan["oldContainer"]]:
        raise fail("original_container_set_changed")
    container = _container(ids[0])
    _validate_container_identity(container, plan, target=False, bind_host=bind_host)
    if container.get("State", {}).get("Running") is not True:
        raise fail("original_container_not_running")
    if container.get("State", {}).get("Health", {}).get("Status") != "healthy":
        raise fail("original_container_not_healthy")
    metadata = _runtime_metadata(ids[0])
    _check_metadata_against_plan(metadata, plan, before_stop=True)
    return ids[0], container, metadata


def _receipt_path(plan_path: Path, plan_sha: str, phase: str, suffix: str) -> Path:
    return plan_path.parent / f".um1651-hub-upgrade-{plan_sha}-{phase}.{suffix}"


def _record_claim(plan_path: Path, plan_sha: str, phase: str) -> Path:
    path = _receipt_path(plan_path, plan_sha, phase, "claim.json")
    _write_exclusive(path, {"planSha256": plan_sha, "phase": phase, "state": "claimed"})
    return path


def _record_receipt(plan_path: Path, plan_sha: str, phase: str,
                    state: str, metadata: dict[str, object]) -> None:
    value = {"planSha256": plan_sha, "phase": phase, "state": state, **metadata}
    _write_exclusive(_receipt_path(plan_path, plan_sha, phase, "receipt.json"), value)


def _record_failure_if_missing(plan_path: Path, plan_sha: str, phase: str,
                               state: str, metadata: dict[str, object]) -> None:
    path = _receipt_path(plan_path, plan_sha, phase, "receipt.json")
    if not os.path.lexists(path):
        _record_receipt(plan_path, plan_sha, phase, state, metadata)


def _postcondition_delay(deadline: float, reason: str) -> None:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise fail(reason)
    time.sleep(min(POSTCONDITION_POLL_SECONDS, remaining))


def _remaining_timeout(deadline: float, ceiling: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise fail("postcondition_timeout")
    return min(ceiling, remaining)


def _read_receipt(plan_path: Path, plan_sha: str, phase: str) -> dict[str, object]:
    path = _receipt_path(plan_path, plan_sha, phase, "receipt.json")
    try:
        value = json.loads(_read_private(path))
    except (UnicodeDecodeError, json.JSONDecodeError):
        raise fail("phase_receipt_invalid") from None
    if (not isinstance(value, dict) or value.get("planSha256") != plan_sha
            or value.get("phase") != phase or value.get("state") != "verified"):
        recovery = _receipt_path(plan_path, plan_sha, phase, "independent-readback.json")
        try:
            checked = json.loads(_read_private(recovery))
        except (OSError, PhaseFailure, ValueError):
            raise fail("prior_phase_not_verified") from None
        if (phase != "stop" or checked.get("planSha256") != plan_sha
                or checked.get("phase") != phase or checked.get("state") != "verified"
                or checked.get("originalReceiptSha256") != _sha(_read_private(path))):
            raise fail("independent_readback_invalid")
        return checked
    return value


def _claim_unused(plan_path: Path, plan_sha: str, phase: str) -> None:
    claim = _receipt_path(plan_path, plan_sha, phase, "claim.json")
    receipt = _receipt_path(plan_path, plan_sha, phase, "receipt.json")
    if claim.exists() or receipt.exists():
        raise fail("phase_already_claimed_or_recorded")


def _claim_after_preflight(plan_path: Path, plan_sha: str, phase: str) -> None:
    _claim_unused(plan_path, plan_sha, phase)
    _record_claim(plan_path, plan_sha, phase)


def _stop_phase(plan_path: Path, plan_sha: str, plan: dict[str, object],
                api: _Coolify, bind_host: str) -> dict[str, object]:
    _claim_unused(plan_path, plan_sha, "stop")
    service, _ = _service_view(api, plan)
    if service.get("status") != plan.get("serviceStatus"):
        raise fail("service_status_compare_failed")
    _image_identity(plan)
    container_id, _, metadata = _old_runtime(plan, bind_host)
    _claim_after_preflight(plan_path, plan_sha, "stop")
    try:
        response = api.request("/stop?docker_cleanup=false", method="POST")
    except PhaseFailure:
        _record_receipt(plan_path, plan_sha, "stop", "outcome_unknown", {
            "containerId": container_id,
            "sourceComposeSha256": plan["rawComposeSha256"],
            "configSha256": metadata["configSha256"],
        })
        raise
    try:
        deadline = time.monotonic() + POSTCONDITION_TIMEOUT_SECONDS
        while True:
            stopped, _ = _service_view(
                api, plan, timeout=_remaining_timeout(deadline, HTTP_TIMEOUT_SECONDS),
            )
            if stopped.get("status") not in STOPPED_STATUSES:
                _postcondition_delay(deadline, "stop_postcondition_timeout")
                continue
            old = _container(container_id, timeout=_remaining_timeout(deadline, COMMAND_TIMEOUT_SECONDS))
            if (old.get("State", {}).get("Running") is not False
                    or _running_ids(f"{IMAGE_NAME}:{plan['service']['source_commit']}",
                                    timeout=_remaining_timeout(deadline, COMMAND_TIMEOUT_SECONDS))):
                _postcondition_delay(deadline, "stop_postcondition_timeout")
                continue
            break
        _record_receipt(plan_path, plan_sha, "stop", "verified", {
            "containerId": container_id,
            "sourceComposeSha256": plan["rawComposeSha256"],
            "configSha256": metadata["configSha256"],
            "stopResponseKeys": sorted(response) if isinstance(response, dict) else [],
        })
    except PhaseFailure as error:
        _record_failure_if_missing(plan_path, plan_sha, "stop", "verification_failed",
                                   {"reason": str(error), "containerId": container_id})
        raise
    except Exception as error:
        _record_failure_if_missing(plan_path, plan_sha, "stop", "verification_failed",
                                   {"errorType": type(error).__name__, "containerId": container_id})
        raise fail("stop_verification_failed") from None
    return {"phase": "stop", "state": "verified"}


def _expected_target_compose(plan: dict[str, object]) -> dict[str, object]:
    result = copy.deepcopy(plan["rawCompose"])
    unit = result["services"]["telemetry-hub"]
    labels = unit["labels"]
    unit["image"] = f"{IMAGE_NAME}:{plan['targetCommit']}"
    labels["telemetry.commit"] = plan["targetCommit"]
    return result


def _compose_payload(compose: dict[str, object]) -> dict[str, object]:
    encoded = base64.b64encode(json.dumps(compose, separators=(",", ":")).encode()).decode("ascii")
    return {"docker_compose_raw": encoded, "instant_deploy": False}


def _repin_phase(plan_path: Path, plan_sha: str, plan: dict[str, object],
                 api: _Coolify) -> dict[str, object]:
    _read_receipt(plan_path, plan_sha, "stop")
    _claim_unused(plan_path, plan_sha, "repin")
    current, compose = _service_view(api, plan)
    if current.get("status") not in STOPPED_STATUSES:
        raise fail("service_not_stopped")
    if _running_ids(f"{IMAGE_NAME}:{plan['service']['source_commit']}"):
        raise fail("old_container_still_running")
    _image_identity(plan)
    target_compose = _expected_target_compose(plan)
    target_hash = _sha(_canonical(target_compose))
    _claim_after_preflight(plan_path, plan_sha, "repin")
    try:
        response = api.request("", method="PATCH", payload=_compose_payload(target_compose))
    except PhaseFailure:
        _record_receipt(plan_path, plan_sha, "repin", "outcome_unknown", {
            "sourceComposeSha256": plan["rawComposeSha256"],
            "targetComposeSha256": target_hash,
            "targetImageId": plan["targetImageId"],
        })
        raise
    try:
        deadline = time.monotonic() + POSTCONDITION_TIMEOUT_SECONDS
        while True:
            after, live_compose = _live_service_compose(
                api, plan, timeout=_remaining_timeout(deadline, HTTP_TIMEOUT_SECONDS),
            )
            if live_compose == plan["rawCompose"]:
                _postcondition_delay(deadline, "repin_postcondition_timeout")
                continue
            if live_compose != target_compose or _sha(_canonical(live_compose)) != target_hash:
                raise fail("repin_postcondition_compare_failed")
            if after.get("status") not in STOPPED_STATUSES:
                _postcondition_delay(deadline, "repin_postcondition_timeout")
                continue
            if _running_ids(f"{IMAGE_NAME}:{plan['targetCommit']}",
                            timeout=_remaining_timeout(deadline, COMMAND_TIMEOUT_SECONDS)):
                _postcondition_delay(deadline, "repin_postcondition_timeout")
                continue
            break
        _record_receipt(plan_path, plan_sha, "repin", "verified", {
            "sourceComposeSha256": plan["rawComposeSha256"],
            "targetComposeSha256": target_hash,
            "targetImageId": plan["targetImageId"],
            "patchResponseKeys": sorted(response) if isinstance(response, dict) else [],
        })
    except PhaseFailure as error:
        _record_failure_if_missing(plan_path, plan_sha, "repin", "verification_failed",
                                   {"reason": str(error), "targetComposeSha256": target_hash})
        raise
    except Exception as error:
        _record_failure_if_missing(plan_path, plan_sha, "repin", "verification_failed",
                                   {"errorType": type(error).__name__, "targetComposeSha256": target_hash})
        raise fail("repin_verification_failed") from None
    return {"phase": "repin", "state": "verified"}


def _port_is_free(bind: str) -> None:
    sock = socket.socket()
    try:
        sock.bind((bind, 4318))
    except OSError:
        raise fail("private_receiver_port_unavailable") from None
    finally:
        sock.close()


def _start_phase(plan_path: Path, plan_sha: str, plan: dict[str, object],
                 api: _Coolify, bind: str) -> dict[str, object]:
    repin = _read_receipt(plan_path, plan_sha, "repin")
    _claim_unused(plan_path, plan_sha, "start")
    current, compose = api.request(), None
    if (not isinstance(current, dict)
            or current.get("uuid") != plan["service"]["uuid"]):
        raise fail("service_response_invalid")
    compose = _parse_raw_compose(current)
    target_compose = _expected_target_compose(plan)
    target_hash = _sha(_canonical(target_compose))
    if compose != target_compose or _sha(_canonical(compose)) != repin.get("targetComposeSha256"):
        raise fail("target_raw_compose_compare_failed")
    if current.get("status") not in STOPPED_STATUSES:
        raise fail("service_not_stopped")
    if _running_ids(f"{IMAGE_NAME}:{plan['targetCommit']}"):
        raise fail("target_container_already_running")
    _image_identity(plan)
    _port_is_free(bind)
    _claim_after_preflight(plan_path, plan_sha, "start")
    try:
        response = api.request("/start", method="POST")
    except PhaseFailure:
        _record_receipt(plan_path, plan_sha, "start", "outcome_unknown", {
            "targetComposeSha256": target_hash,
            "targetImageId": plan["targetImageId"],
        })
        raise
    try:
        deadline = time.monotonic() + POSTCONDITION_TIMEOUT_SECONDS
        while True:
            after, after_compose = _live_service_compose(
                api, plan, timeout=_remaining_timeout(deadline, HTTP_TIMEOUT_SECONDS),
            )
            if after_compose != target_compose:
                raise fail("start_postcondition_compose_changed")
            if after.get("status") not in STARTED_STATUSES:
                _postcondition_delay(deadline, "start_postcondition_timeout")
                continue
            ids = _running_ids(f"{IMAGE_NAME}:{plan['targetCommit']}",
                               timeout=_remaining_timeout(deadline, COMMAND_TIMEOUT_SECONDS))
            if not ids:
                _postcondition_delay(deadline, "start_postcondition_timeout")
                continue
            if len(ids) != 1:
                raise fail("target_container_count_invalid")
            container = _container(ids[0], timeout=_remaining_timeout(deadline, COMMAND_TIMEOUT_SECONDS))
            _validate_container_identity(container, plan, target=True, bind_host=bind)
            if container.get("State", {}).get("Running") is not True:
                _postcondition_delay(deadline, "start_postcondition_timeout")
                continue
            health = container.get("State", {}).get("Health", {}).get("Status")
            if health not in {"healthy", "starting"}:
                raise fail("target_container_health_invalid")
            metadata = _runtime_metadata(ids[0], timeout=_remaining_timeout(deadline, COMMAND_TIMEOUT_SECONDS))
            _check_metadata_against_plan(metadata, plan, before_stop=False)
            break
        health = container.get("State", {}).get("Health", {}).get("Status")
        phase_state = "verified" if health == "healthy" else "started"
        _record_receipt(plan_path, plan_sha, "start", phase_state, {
            "targetComposeSha256": target_hash,
            "targetImageId": plan["targetImageId"],
            "containerId": ids[0],
            "containerHealth": health,
            "configSha256": metadata["configSha256"],
            "volumeNameSha256": _sha(plan["durableVolume"].encode()),
            "configSourceSha256": _sha(plan["configMountSource"].encode()),
            "startResponseKeys": sorted(response) if isinstance(response, dict) else [],
        })
    except PhaseFailure as error:
        _record_failure_if_missing(plan_path, plan_sha, "start", "verification_failed",
                                   {"reason": str(error), "targetComposeSha256": target_hash})
        raise
    except Exception as error:
        _record_failure_if_missing(plan_path, plan_sha, "start", "verification_failed",
                                   {"errorType": type(error).__name__, "targetComposeSha256": target_hash})
        raise fail("start_verification_failed") from None
    return {"phase": "start", "state": phase_state, "containerId": ids[0],
            "health": container.get("State", {}).get("Health", {}).get("Status")}


def run() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("phase", choices=("stop", "repin", "start"))
    parser.add_argument("plan", type=Path)
    parser.add_argument("plan_sha256")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-f0-9]{64}", args.plan_sha256):
        raise fail("invalid_plan_sha256")
    plan_path = args.plan.absolute()
    if plan_path.name != f".um1651-hub-upgrade-{_plan_target_from_name(plan_path)}.plan.json":
        raise fail("plan_filename_invalid")
    plan, plan_sha = _plan(plan_path, args.plan_sha256)
    if plan_path.name != f".um1651-hub-upgrade-{plan['targetCommit']}.plan.json":
        raise fail("plan_target_filename_mismatch")
    base_url, bind = _load_routing()
    token = _coolify_token()
    api = _Coolify(base_url, token, plan["service"]["uuid"])
    if args.phase == "stop":
        result = _stop_phase(plan_path, plan_sha, plan, api, bind)
    elif args.phase == "repin":
        result = _repin_phase(plan_path, plan_sha, plan, api)
    else:
        result = _start_phase(plan_path, plan_sha, plan, api, bind)
    print(json.dumps({**result, "planSha256": plan_sha}, sort_keys=True))
    return 0


def _plan_target_from_name(path: Path) -> str:
    match = re.fullmatch(r"\.um1651-hub-upgrade-([a-f0-9]{40})\.plan\.json", path.name)
    if not match:
        raise fail("plan_filename_invalid")
    return match.group(1)


if __name__ == "__main__":
    try:
        sys.exit(run())
    except PhaseFailure as error:
        print(json.dumps({"phase": "refused", "reason": str(error)}, sort_keys=True))
        sys.exit(2)
    except (OSError, subprocess.SubprocessError) as error:
        print(json.dumps({"phase": "failed", "errorType": type(error).__name__}, sort_keys=True))
        sys.exit(1)
    except Exception as error:
        print(json.dumps({"phase": "failed", "errorType": type(error).__name__}, sort_keys=True))
        sys.exit(1)
