"""Mocked phase tests; every file and service response is a temporary fixture."""

from __future__ import annotations

import base64
import contextlib
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import yaml


MODULE_PATH = Path(__file__).with_name("upgrade-reviewed-hub.py")
SPEC = importlib.util.spec_from_file_location("upgrade_reviewed_hub_fixture", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
UPGRADE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(UPGRADE)


TARGET = "a" * 40
OLD = "b" * 40
SERVICE_UUID = "a4tp0kk9jmfibzvbmsxvmtqg"
BIND_HOST = "127.0.0.1"
CONFIG_SOURCE = "/tmp/fixture-secrets/telemetry-hub.json"
CONFIG_SHA = "4de" + "1" * 61
TARGET_IMAGE_ID = "sha256:target-image-fixture"
OLD_IMAGE_ID = "sha256:old-image-fixture"
OLD_CONTAINER_ID = "old-container-fixture"
NEW_CONTAINER_ID = "new-container-fixture"
VOLUME_NAME = "botfleet-server_telemetry-hub-journal"


def compose_fixture() -> dict[str, object]:
    return {
        "services": {
            "telemetry-hub": {
                "image": f"{UPGRADE.IMAGE_NAME}:{OLD}",
                "network_mode": "host",
                "read_only": True,
                "labels": {"telemetry.commit": OLD, "fixture.keep": "unchanged"},
                "environment": {
                    "TELEMETRY_HUB_CONFIG_FILE": "/run/secrets/telemetry-hub.json",
                    "TELEMETRY_HUB_BIND_HOST": BIND_HOST,
                },
                "volumes": [
                    "journal:/data",
                    {"type": "bind", "source": CONFIG_SOURCE,
                     "target": "/run/secrets/telemetry-hub.json", "read_only": True},
                ],
            },
        },
        "volumes": {
            "journal": {"name": VOLUME_NAME, "external": True},
        },
    }


def plan_fixture() -> dict[str, object]:
    raw = compose_fixture()
    return {
        "mode": "plan-only",
        "targetCommit": TARGET,
        "targetImageId": TARGET_IMAGE_ID,
        "service": {"uuid": SERVICE_UUID, "source_commit": OLD},
        "serviceStatus": "running:healthy",
        "oldContainer": OLD_CONTAINER_ID,
        "oldImageId": OLD_IMAGE_ID,
        "rawCompose": raw,
        "rawComposeSha256": hashlib.sha256(UPGRADE._canonical(raw)).hexdigest(),
        "targetComposeSha256": "0" * 64,
        "currentCompose": raw,
        "currentComposeSha256": hashlib.sha256(UPGRADE._canonical(raw)).hexdigest(),
        "preparedComposeSha256": "1" * 64,
        "metadata": {
            "configSha256": CONFIG_SHA,
            "configUid": 10001,
            "configMode": 0o600,
            "journalBase": 0,
            "journalBytes": 128,
            "sentryOffset": 128,
            "pendingBytes": 0,
        },
        "durableVolume": VOLUME_NAME,
        "configMountSource": CONFIG_SOURCE,
        "upgradeContract": "fixture",
        "runtimeChanges": False,
    }


class FakeCoolify:
    def __init__(self, plan: dict[str, object], *, wrong_uuid: bool = False,
                 unknown_stop: bool = False, stop_pending_reads: int = 0,
                 repin_pending_reads: int = 0, start_pending_reads: int = 0):
        self.plan = plan
        self.compose = copy.deepcopy(plan["rawCompose"])
        self.status = "running:healthy"
        self.uuid = "wrong-uuid-fixture" if wrong_uuid else SERVICE_UUID
        self.old_running = True
        self.target_running = False
        self.unknown_stop = unknown_stop
        self.stop_pending_reads = stop_pending_reads
        self.repin_pending_reads = repin_pending_reads
        self.start_pending_reads = start_pending_reads
        self.stop_posts = 0
        self.patch_posts = 0
        self.start_posts = 0
        self.requests: list[tuple[str, str]] = []

    def request(self, suffix: str = "", *, method: str = "GET",
                payload: dict[str, object] | None = None,
                timeout: float = UPGRADE.HTTP_TIMEOUT_SECONDS) -> object:
        self.requests.append((method, suffix))
        if method == "GET":
            result = self._view()
            if self.stop_posts and self.stop_pending_reads:
                self.stop_pending_reads -= 1
                if not self.stop_pending_reads:
                    self.status = "degraded:unhealthy"
            elif self.patch_posts and self.repin_pending_reads:
                self.repin_pending_reads -= 1
                if not self.repin_pending_reads:
                    self.status = "degraded:unhealthy"
            elif self.start_posts and self.start_pending_reads:
                self.start_pending_reads -= 1
                if not self.start_pending_reads:
                    self.status = "running:healthy"
            return result
        if method == "POST" and suffix == "/stop?docker_cleanup=false":
            self.stop_posts += 1
            self.old_running = False
            if self.unknown_stop:
                raise UPGRADE.fail("HTTPError")
            if not self.stop_pending_reads:
                self.status = "degraded:unhealthy"
            return {"accepted": True}
        if method == "PATCH" and suffix == "":
            self.patch_posts += 1
            encoded = payload["docker_compose_raw"]
            self.compose = json.loads(base64.b64decode(encoded, validate=True))
            if self.repin_pending_reads:
                self.status = "running:healthy"
            else:
                self.status = "degraded:unhealthy"
            return {"updated": True}
        if method == "POST" and suffix == "/start":
            self.start_posts += 1
            self.target_running = True
            if self.start_pending_reads:
                self.status = "degraded:unhealthy"
            else:
                self.status = "running:healthy"
            return {"accepted": True}
        raise AssertionError("unexpected mocked API request")

    def _view(self) -> dict[str, object]:
        return {
            "uuid": self.uuid,
            "status": self.status,
            "docker_compose_raw": yaml.safe_dump(self.compose, sort_keys=False),
        }


class FakeDocker:
    def __init__(self, api: FakeCoolify, plan: dict[str, object]):
        self.api = api
        self.plan = plan
        self.metadata = copy.deepcopy(plan["metadata"])

    def json(self, args: list[str], **kwargs: object) -> object:
        if args[:2] == ["image", "inspect"]:
            return [{"Id": TARGET_IMAGE_ID, "Config": {"Labels": {
                UPGRADE.REVISION_LABEL: TARGET,
            }}}]
        if args[:1] == ["inspect"] and args[1] in {OLD_CONTAINER_ID, NEW_CONTAINER_ID}:
            is_target = args[1] == NEW_CONTAINER_ID
            running = self.api.target_running if is_target else self.api.old_running
            image_ref = f"{UPGRADE.IMAGE_NAME}:{TARGET if is_target else OLD}"
            image_id = TARGET_IMAGE_ID if is_target else OLD_IMAGE_ID
            revision = TARGET if is_target else OLD
            return [{
                "Id": args[1],
                "Image": image_id,
                "Config": {
                    "Image": image_ref,
                    "User": "10001:10001",
                    "Labels": {UPGRADE.REVISION_LABEL: revision},
                    "Env": [
                        f"COOLIFY_RESOURCE_UUID={SERVICE_UUID}",
                        "TELEMETRY_HUB_CONFIG_FILE=/run/secrets/telemetry-hub.json",
                        f"TELEMETRY_HUB_BIND_HOST={BIND_HOST}",
                    ],
                },
                "HostConfig": {
                    "ReadonlyRootfs": True,
                    "NetworkMode": "host",
                    "PortBindings": None,
                },
                "Mounts": [
                    {"Type": "volume", "Name": VOLUME_NAME, "Destination": "/data"},
                    {"Type": "bind", "Source": CONFIG_SOURCE,
                     "Destination": "/run/secrets/telemetry-hub.json", "RW": False},
                ],
                "State": {
                    "Running": running,
                    "Health": {"Status": "healthy" if running else "unhealthy"},
                },
            }]
        raise AssertionError("unexpected mocked Docker JSON call")

    def bytes(self, args: list[str], **kwargs: object) -> bytes:
        if args[:1] == ["ps"]:
            ancestor = next(item.split("=", 1)[1] for item in args if item.startswith("ancestor="))
            if ancestor.endswith(OLD) and self.api.old_running:
                return (OLD_CONTAINER_ID + "\n").encode()
            if ancestor.endswith(TARGET) and self.api.target_running:
                return (NEW_CONTAINER_ID + "\n").encode()
            return b""
        if args[:1] == ["exec"]:
            return json.dumps(self.metadata).encode()
        raise AssertionError("unexpected mocked Docker call")


class UpgradeReviewedHubTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = tempfile.TemporaryDirectory(prefix="upgrade-reviewed-hub-")
        self.root = Path(self.tempdir.name)
        self.plan = plan_fixture()
        self.plan_path = self.root / f".um1651-hub-upgrade-{TARGET}.plan.json"
        self.plan_bytes = json.dumps(self.plan, sort_keys=True, indent=2).encode() + b"\n"
        self.plan_path.write_bytes(self.plan_bytes)
        self.plan_path.chmod(0o600)
        self.plan_sha = hashlib.sha256(self.plan_bytes).hexdigest()
        self.api = FakeCoolify(self.plan)
        self.docker = FakeDocker(self.api, self.plan)

    def tearDown(self) -> None:
        self.tempdir.cleanup()

    def execute_phase(self, phase: str) -> dict[str, object]:
        stdout = io.StringIO()
        with contextlib.redirect_stdout(stdout), \
                mock.patch.object(sys, "argv", ["upgrade-reviewed-hub.py", phase,
                                                  str(self.plan_path), self.plan_sha]), \
                mock.patch.object(UPGRADE, "_load_routing", return_value=(
                    "https://host.jays.services/api/v1", BIND_HOST)), \
                mock.patch.object(UPGRADE, "_coolify_token", return_value="fixture-only-token"), \
                mock.patch.object(UPGRADE, "_Coolify", return_value=self.api), \
                mock.patch.object(UPGRADE, "_docker_json", side_effect=self.docker.json), \
                mock.patch.object(UPGRADE, "_docker", side_effect=self.docker.bytes), \
                mock.patch.object(UPGRADE, "_port_is_free"), \
                mock.patch.object(UPGRADE, "POSTCONDITION_POLL_SECONDS", 0):
            self.assertEqual(UPGRADE.run(), 0)
        return json.loads(stdout.getvalue())

    def test_three_phases_preserve_raw_generated_volume_and_update_once(self) -> None:
        self.api.stop_pending_reads = 1
        self.api.repin_pending_reads = 1
        self.api.start_pending_reads = 1
        self.assertEqual(self.execute_phase("stop")["state"], "verified")
        self.assertEqual(self.execute_phase("repin")["state"], "verified")
        result = self.execute_phase("start")
        self.assertEqual(result["state"], "verified")
        self.assertEqual(self.api.stop_posts, 1)
        self.assertEqual(self.api.patch_posts, 1)
        self.assertEqual(self.api.start_posts, 1)

        expected = copy.deepcopy(self.plan["rawCompose"])
        expected["services"]["telemetry-hub"]["image"] = f"{UPGRADE.IMAGE_NAME}:{TARGET}"
        expected["services"]["telemetry-hub"]["labels"]["telemetry.commit"] = TARGET
        self.assertEqual(self.api.compose, expected)
        self.assertEqual(self.api.compose["volumes"], self.plan["rawCompose"]["volumes"])
        self.assertEqual(
            self.api.compose["services"]["telemetry-hub"]["labels"]["fixture.keep"],
            "unchanged",
        )

    def test_raw_compose_compare_failure_prevents_stop(self) -> None:
        self.api.compose["services"]["telemetry-hub"]["environment"]["DRIFT"] = "fixture"
        with self.assertRaises(UPGRADE.PhaseFailure):
            self.execute_phase("stop")
        self.assertEqual(self.api.stop_posts, 0)

    def test_mismatched_service_uuid_prevents_stop(self) -> None:
        self.api.uuid = "z" * 24
        with self.assertRaises(UPGRADE.PhaseFailure):
            self.execute_phase("stop")
        self.assertEqual(self.api.stop_posts, 0)

    def test_duplicate_claim_prevents_any_api_call(self) -> None:
        claim = UPGRADE._receipt_path(self.plan_path, self.plan_sha, "stop", "claim.json")
        claim.write_text("fixture claim")
        claim.chmod(0o600)
        with self.assertRaises(UPGRADE.PhaseFailure):
            self.execute_phase("stop")
        self.assertEqual(self.api.requests, [])

    def test_unknown_stop_response_records_claim_and_never_retries_post(self) -> None:
        self.api.unknown_stop = True
        with self.assertRaises(UPGRADE.PhaseFailure):
            self.execute_phase("stop")
        self.assertEqual(self.api.stop_posts, 1)
        receipt = UPGRADE._receipt_path(self.plan_path, self.plan_sha, "stop", "receipt.json")
        value = json.loads(receipt.read_bytes())
        self.assertEqual(value["state"], "outcome_unknown")
        with self.assertRaises(UPGRADE.PhaseFailure):
            self.execute_phase("stop")
        self.assertEqual(self.api.stop_posts, 1)

    def test_coolify_path_allowlist_rejects_non_service_route_without_opening(self) -> None:
        client = UPGRADE._Coolify("https://example.invalid/api/v1", "fixture-token", SERVICE_UUID)
        with mock.patch.object(client, "_opener") as opener:
            with self.assertRaises(UPGRADE.PhaseFailure):
                client.request("/other", method="DELETE")
        opener.open.assert_not_called()


if __name__ == "__main__":
    unittest.main()
