#!/usr/bin/env python3
"""Finite offline lifecycle/proof model; live execution is unconditionally refused."""
from __future__ import annotations
import argparse
import copy
import importlib.util
import json
from pathlib import Path
import re
import stat
import sys
import time
import urllib.parse

SPEC = importlib.util.spec_from_file_location("pinned_engine", Path(__file__).with_name("pinned-engine-lifecycle.py"))
E = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(E)
Stop = E.Stop
SCHEMA = "telemetry-hub-finite-lifecycle/v1"
PHASES = ("preflight-recovery", "stopped-transition", "prestart", "poststart")
ARCHIVE_LIMIT = 2 * E.MAX_RESPONSE
ARCHIVE_QUERY = "/archive?" + urllib.parse.urlencode({"path": "/run/secrets/telemetry-hub.json"})


def exact(data, fields, message):
    if not isinstance(data, dict) or set(data) != set(fields):
        raise Stop(message)


def digest(value):
    if not isinstance(value, str) or not re.fullmatch(r"[0-9a-f]{64}", value):
        raise Stop("exact SHA256 required")


def recovery_plan(manifest, snapshot):
    return {"old_id": manifest["old_id"], "old_name": manifest["old_name"], "image_id": manifest["image_id"],
            "restoration_payload_sha256": manifest["payload_sha256"], "old_snapshot_sha256": snapshot["old_sha256"],
            "journal_volume_sha256": manifest["volume_sha256"], "mode": "separately-reviewed-only"}


def validate_plan(plan):
    exact(plan, ("schema", "lifecycle", "snapshot", "reservation_sha256", "rollback_plan_sha256", "limits"), "exact finite plan required")
    if plan["schema"] != SCHEMA:
        raise Stop("unsupported finite plan schema")
    manifest = plan["lifecycle"]
    exact(manifest, ("old_id", "old_name", "project", "service", "resolved_sha256", "payload_sha256", "daemon_sha256",
                     "volume_name", "volume_sha256", "image_id"), "exact lifecycle fields required")
    if not isinstance(manifest["old_id"], str) or not re.fullmatch(r"[0-9a-f]{64}", manifest["old_id"]):
        raise Stop("full old container ID required")
    if not isinstance(manifest["image_id"], str) or not re.fullmatch(r"sha256:[0-9a-f]{64}", manifest["image_id"]):
        raise Stop("immutable image ID required")
    for key in ("old_name", "project", "service", "volume_name"):
        if not isinstance(manifest[key], str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,200}", manifest[key]):
            raise Stop("exact existing selector required")
    for key in ("resolved_sha256", "payload_sha256", "daemon_sha256", "volume_sha256"):
        digest(manifest[key])
    snapshot = plan["snapshot"]
    exact(snapshot, ("old_sha256", "new_sha256", "old_map_sha256", "new_map_sha256", "new_members"), "exact snapshot plan required")
    for key in ("old_sha256", "new_sha256", "old_map_sha256", "new_map_sha256"):
        digest(snapshot[key])
    members = snapshot["new_members"]
    if (not isinstance(members, list) or any(not isinstance(item, str) or not re.fullmatch(r"[a-z0-9._-]{1,80}", item) for item in members)
            or members != sorted(set(members)) or not {"clutch.mac", "kimi-code", "zcode"} <= set(members)):
        raise Stop("complete sorted snapshot membership required")
    digest(plan["reservation_sha256"])
    digest(plan["rollback_plan_sha256"])
    if E.sha(recovery_plan(manifest, snapshot)) != plan["rollback_plan_sha256"]:
        raise Stop("exact reconstruction plan hash required")
    limits = plan["limits"]
    exact(limits, ("total_seconds", "phase_seconds", "health_checks"), "exact finite limits required")
    for key, maximum in (("total_seconds", 300), ("phase_seconds", 30), ("health_checks", 10)):
        if type(limits[key]) is not int or not 1 <= limits[key] <= maximum:
            raise Stop("finite limit outside reviewed bound")
    if limits["phase_seconds"] > limits["total_seconds"]:
        raise Stop("phase exceeds whole-run bound")


class ExactEngine:
    """Exact routes, bodies, statuses, counts and mutation order over an injected seam.

    The supplied real backend remains ReadOnlyEngine, which refuses mutations.
    This wrapper has no live transport or mutation-enabling switch of its own.
    """
    def __init__(self, manifest, transport, health_checks, *, receipt, check):
        self.m, self.transport, self.receipt, self.check = copy.deepcopy(manifest), transport, receipt, check
        self.health_checks = health_checks
        filters = json.dumps({"label": ["com.docker.compose.project=" + self.m["project"],
                                        "com.docker.compose.service=" + self.m["service"]]}, separators=(",", ":"))
        selector = "/containers/json?" + urllib.parse.urlencode({"all": "true", "filters": filters})
        self.routes = {}
        self.archive_routes = set()
        for path, maximum in (("/info", 1), ("/version", 1), (selector, 6 + health_checks),
                              ("/containers/" + self.m["old_id"] + "/json", 4),
                              ("/images/" + urllib.parse.quote(self.m["image_id"], safe="") + "/json", 3),
                              ("/volumes/" + urllib.parse.quote(self.m["volume_name"], safe=""), 3)):
            self.routes[("GET", E.PREFIX + path)] = (200, maximum, None)
        old = "/containers/" + self.m["old_id"]
        self.mutations = [("POST", E.PREFIX + old + "/stop?t=15"),
                          ("DELETE", E.PREFIX + old + "?v=false&force=false&link=false"),
                          ("POST", E.PREFIX + "/containers/create?" + urllib.parse.urlencode({"name": self.m["old_name"]}))]
        self.routes[self.mutations[0]] = (204, 1, None)
        self.routes[self.mutations[1]] = (204, 1, None)
        self.routes[self.mutations[2]] = (201, 1, self.m["payload_sha256"])
        self.counts, self.total, self.stage = {}, 0, 0
        self.maximum = 30 + 2 * health_checks
        self.authorized = None
        self.failed = False

    def release_next(self):
        if self.failed or self.authorized is not None or self.stage >= len(self.mutations):
            raise Stop("mutation release is terminal or repeated")
        self.authorized = self.mutations[self.stage]

    def request(self, method, path, body=None):
        key = (method, path)
        try:
            self.check()
            if self.failed or key not in self.routes:
                raise Stop("exact Engine route refused")
            expected, maximum, body_hash = self.routes[key]
            if ((body_hash is None and body is not None) or (body_hash is not None and E.sha(body) != body_hash)
                    or len(json.dumps(body, sort_keys=True, separators=(",", ":")).encode()) > E.MAX_RESPONSE
                    or self.counts.get(key, 0) >= maximum or self.total >= self.maximum):
                raise Stop("exact Engine body or request count refused")
            if method != "GET" and (key != self.authorized or key != self.mutations[self.stage]):
                raise Stop("mutation order or proof release refused")
            self.counts[key] = self.counts.get(key, 0) + 1
            self.total += 1
            self.authorized = None
            status, value = self.transport.request(method, path, copy.deepcopy(body))
            self.check()
            if key in self.archive_routes:
                valid = (isinstance(value, dict) and set(value) == {"content_type", "body"}
                         and value["content_type"] == "application/x-tar" and isinstance(value["body"], bytes)
                         and 0 < len(value["body"]) <= ARCHIVE_LIMIT)
            else:
                valid = len(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()) <= E.MAX_RESPONSE
            if type(status) is not int or not valid:
                raise Stop("Engine response shape or size refused")
            if method != "GET":
                # Preserve bounded parsed warnings/response before status or warning rejection.
                self.receipt("mutation-response-" + str(self.stage), {"method": method, "path": path, "status": status, "response": value})
            if status != expected:
                raise Stop("unexpected Engine status; terminal outcome")
            if key == self.mutations[2]:
                if (not isinstance(value, dict) or set(value) != {"Id", "Warnings"}
                        or not isinstance(value["Id"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["Id"])
                        or value["Id"] == self.m["old_id"] or value["Warnings"] not in (None, [])):
                    raise Stop("create identity or warnings require reconciliation")
                identifier = value["Id"]
                self.routes[("GET", E.PREFIX + "/containers/" + identifier + "/json")] = (200, 6 + self.health_checks, None)
                archive = ("GET", E.PREFIX + "/containers/" + identifier + ARCHIVE_QUERY)
                self.routes[archive] = (200, 2, None)
                self.archive_routes.add(archive)
                start = ("POST", E.PREFIX + "/containers/" + identifier + "/start")
                self.mutations.append(start)
                self.routes[start] = (204, 1, None)
            if method != "GET":
                self.stage += 1
            return status, copy.deepcopy(value)
        except Exception:
            self.failed = True
            raise Stop("finite Engine boundary failed; preserve receipts and never retry") from None


class PhaseDeadline:
    def __init__(self, total, seconds):
        self.total = total
        self.local = E.Deadline(total.clock, seconds)

    def remaining(self):
        return min(self.total.remaining(), self.local.remaining())


class FiniteLifecycle(E.Lifecycle):
    """Four one-shot proof phases with cooperative deadlines and private receipts.

    Overdue synchronous work stays owned until it returns; there is no background
    timeout, cancellation claim or lease release while a proof operation is live.
    A production mutation transport is not supplied.
    """
    def __init__(self, plan, transport, *, proofs, receipt, clock=time.monotonic, pause=time.sleep):
        validate_plan(plan)
        self.plan, self.proofs = copy.deepcopy(plan), proofs
        self.deadline = None
        self.phases = []
        self.started = False
        self.proven = set()
        self.last_inspect = None
        self.original_pause = pause
        super().__init__(self.plan["lifecycle"], None, receipt=receipt, clock=clock, pause=self.bounded_pause)
        self.transport = ExactEngine(self.m, transport, self.plan["limits"]["health_checks"], receipt=self.record, check=self.check)
        binder = getattr(proofs, "bind_engine", None)
        if binder is not None:
            binder(self.transport, self.m)

    def check(self):
        if self.deadline is None:
            raise Stop("finite run has not begun")
        self.deadline.remaining()

    def sole(self, expected_id, *, running):
        inspected = super().sole(expected_id, running=running)
        self.last_inspect = copy.deepcopy(inspected)
        return inspected

    def bounded_pause(self, seconds):
        self.check()
        self.original_pause(seconds)
        self.check()

    def record(self, phase, data=None):
        self.check()
        if self.sequence >= 32 or not re.fullmatch(r"[a-z0-9-]{1,100}", phase):
            raise Stop("private receipt count or phase refused")
        frozen = copy.deepcopy({} if data is None else data)
        expected = E.sha(frozen)
        budget = PhaseDeadline(self.deadline, self.plan["limits"]["phase_seconds"])
        budget.remaining()
        writer = getattr(self.receipt, "write", None)
        ack = (writer(f"{self.sequence:02d}-{phase}", frozen, budget) if writer is not None
               else self.receipt(f"{self.sequence:02d}-{phase}", frozen))
        budget.remaining()
        if (not isinstance(ack, dict) or set(ack) != {"sha256", "durable_readback"}
                or ack["sha256"] != expected or ack["durable_readback"] is not True):
            raise Stop("exclusive fsynced private receipt readback required")
        self.sequence += 1

    def phase(self, name, context):
        self.check()
        if len(self.phases) >= len(PHASES) or name != PHASES[len(self.phases)]:
            raise Stop("proof phase order or invocation count refused")
        self.phases.append(name)
        budget = PhaseDeadline(self.deadline, self.plan["limits"]["phase_seconds"])
        budget.remaining()
        result = self.proofs.invoke(name, copy.deepcopy(context), budget)
        budget.remaining()
        if not isinstance(result, dict):
            raise Stop("structured proof required")
        if len(json.dumps(result, sort_keys=True, separators=(",", ":")).encode()) > 8 * E.MAX_RESPONSE:
            raise Stop("private proof size exceeds bound")
        return copy.deepcopy(result)

    def identity(self, value, raw):
        exact(value, ("device", "inode", "uid", "gid", "mode", "size"), "exact snapshot identity required")
        if (any(type(item) is not int for item in value.values()) or value["device"] < 0 or value["inode"] <= 0
                or (value["uid"], value["gid"], value["mode"]) != (10001, 10001, 0o600)
                or value["size"] != len(raw.encode()) or not 0 < value["size"] <= 1024 * 1024):
            raise Stop("snapshot custody proof mismatch")

    def journal(self, value):
        exact(value, ("device", "logical_end", "offset", "dead_letter_bytes", "pending_size", "volume_sha256", "files"), "exact journal proof required")
        if (value["volume_sha256"] != self.m["volume_sha256"]
                or any(type(value[key]) is not int or not 0 <= value[key] <= 2**53 - 1 for key in ("device", "logical_end", "offset", "dead_letter_bytes", "pending_size"))
                or value["offset"] > value["logical_end"] or value["pending_size"] != 0):
            raise Stop("journal identity, position or compaction proof invalid")
        files = value["files"]
        exact(files, ("journal", "dead_letter", "base_state", "sentry_offset"), "exact journal file fingerprints required")
        signatures = [files["journal"]]
        if files["dead_letter"] is not None:
            signatures.append(files["dead_letter"])
        for key in ("base_state", "sentry_offset"):
            exact(files[key], ("stat", "sha256"), "exact state-file fingerprint required")
            digest(files[key]["sha256"])
            signatures.append(files[key]["stat"])
        for observed in signatures:
            if (not isinstance(observed, list) or len(observed) != 9 or any(type(item) is not int or item < 0 for item in observed)
                    or observed[0] != value["device"] or observed[1] == 0
                    or observed[4] != stat.S_IFREG | 0o600 or observed[8] != 1):
                raise Stop("journal physical file fingerprint invalid")
        if (value["logical_end"] < files["journal"][5]
                or value["dead_letter_bytes"] != (0 if files["dead_letter"] is None else files["dead_letter"][5])):
            raise Stop("journal physical sizes differ from aggregate proof")

    def reservation(self, proof):
        if proof["reservation_sha256"] != self.plan["reservation_sha256"]:
            raise Stop("cooperative reservation changed")

    def preflight(self):
        super().preflight()
        proof = self.phase("preflight-recovery", {"inspect": self.old, "payload": self.payload})
        exact(proof, ("old_snapshot", "new_snapshot", "snapshot_backup_readback", "inspect_backup_readback", "payload_backup_readback",
                      "rollback_plan", "snapshot_identity", "reservation_sha256"), "exact recovery proof required")
        self.reservation(proof)
        old, new = proof["old_snapshot"], proof["new_snapshot"]
        if (not isinstance(old, str) or not isinstance(new, str)
                or not 0 < len(old.encode()) <= E.MAX_RESPONSE or not 0 < len(new.encode()) <= E.MAX_RESPONSE):
            raise Stop("private snapshot bytes required")
        snapshot = self.plan["snapshot"]
        manifest = {"old_snapshot_sha256": snapshot["old_sha256"], "old_map_sha256": snapshot["old_map_sha256"],
                    "new_map_sha256": snapshot["new_map_sha256"], "new_members": snapshot["new_members"]}
        if (E.M.C.digest(new) != snapshot["new_sha256"]
                or E.M.replacement(old, E.M.snapshot(new)[E.M.C.HUB_MAP], manifest) != new
                or proof["snapshot_backup_readback"] != old or proof["inspect_backup_readback"] != self.old
                or proof["payload_backup_readback"] != self.payload
                or proof["rollback_plan"] != recovery_plan(self.m, snapshot)):
            raise Stop("private backup, snapshot preservation or reconstruction proof mismatch")
        self.identity(proof["snapshot_identity"], old)
        self.old_raw, self.new_raw = old, new
        self.old_identity = proof["snapshot_identity"]
        self.record("preflight-recovery-proof", proof)
        self.proven.add("stop")

    def stopped_transition(self):
        proof = self.phase("stopped-transition", {"old_sha256": self.plan["snapshot"]["old_sha256"], "new_sha256": self.plan["snapshot"]["new_sha256"],
                                                   "stopped_inspect": self.last_inspect})
        exact(proof, ("before_snapshot", "after_snapshot", "before_identity", "after_identity", "journal_before", "journal_after",
                      "replacement_count", "reservation_sha256"), "exact stopped transition proof required")
        self.reservation(proof)
        self.identity(proof["before_identity"], self.old_raw)
        self.identity(proof["after_identity"], self.new_raw)
        self.journal(proof["journal_before"])
        self.journal(proof["journal_after"])
        if (proof["before_snapshot"] != self.old_raw or proof["after_snapshot"] != self.new_raw
                or proof["before_identity"] != self.old_identity or proof["after_identity"]["device"] != self.old_identity["device"]
                or proof["after_identity"]["inode"] == self.old_identity["inode"]
                or type(proof["replacement_count"]) is not int or proof["replacement_count"] != 1
                or proof["journal_before"] != proof["journal_after"]):
            raise Stop("snapshot transition or stopped journal changed")
        self.new_identity, self.stopped_journal = proof["after_identity"], proof["journal_after"]
        self.record("stopped-transition-proof", proof)
        self.proven.add("remove")

    def verify_runtime_proof(self, name):
        proof = self.phase(name, {"new_id": self.new_id, "snapshot_sha256": self.plan["snapshot"]["new_sha256"], "inspect": self.last_inspect})
        exact(proof, ("container_id", "mounted_snapshot", "snapshot_identity", "journal", "reservation_sha256"), "exact runtime proof required")
        self.reservation(proof)
        self.identity(proof["snapshot_identity"], self.new_raw)
        self.journal(proof["journal"])
        if (proof["container_id"] != self.new_id or proof["mounted_snapshot"] != self.new_raw
                or proof["snapshot_identity"] != self.new_identity):
            raise Stop("actual mounted snapshot or custody proof differs")
        after, before = proof["journal"], self.stopped_journal
        if (after["device"] != before["device"] or after["dead_letter_bytes"] != before["dead_letter_bytes"]
                or after["logical_end"] < before["logical_end"] or after["offset"] < before["offset"]
                or name == "prestart" and after != before):
            raise Stop("journal continuity proof failed")
        self.record(name + "-proof", proof)
        if name == "prestart":
            self.proven.add("start")

    def call(self, method, path, body=None, expected=200):
        self.check()
        if method != "GET":
            stage = self.transport.stage
            needed = ("stop", "remove", "create", "start")[stage] if stage < 4 else None
            if needed == "create" and self.transport.stage == 2:
                self.proven.add("create")
            if needed is None or needed not in self.proven:
                raise Stop("mutation lacks completed proof boundary")
            self.transport.release_next()
        return super().call(method, path, body, expected)

    def run(self):
        if self.started:
            raise Stop("finite lifecycle cannot be resumed or retried")
        self.started = True
        self.deadline = E.Deadline(self.clock, self.plan["limits"]["total_seconds"])
        try:
            result = super().run(stopped_snapshot_transition=self.stopped_transition,
                                 before_start_verify=lambda: self.verify_runtime_proof("prestart"),
                                 after_start_verify=lambda: self.verify_runtime_proof("poststart"))
            self.check()
            return {**result, "mode": "offline_injected_model", "logical_engine_requests": self.transport.total,
                    "logical_engine_request_limit": self.transport.maximum, "proof_phases": len(self.phases), "live_execution_enabled": False}
        except Exception:
            raise Stop("finite lifecycle stopped; preserve private receipts and reconcile") from None
        finally:
            # Completion and every failed proof close this instance, including reads.
            self.transport.failed = True
            close_failed = False
            for resource in (self.transport.transport, self.proofs, self.receipt):
                closer = getattr(resource, "close", None)
                if closer is not None:
                    try:
                        closer()
                    except Exception:
                        close_failed = True
            if close_failed:
                raise Stop("finite resources did not close cleanly; reconcile scoped state") from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plan", required=True)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.execute:
        print(json.dumps({"status": "stopped", "reason": "live finite execution is unconditionally disabled"}), file=sys.stderr)
        raise SystemExit(2)
    raw = Path(args.plan).read_bytes()
    if len(raw) > 1024 * 1024:
        raise Stop("plan exceeds limit")
    plan = E.M.C.decode(raw)
    validate_plan(plan)
    print(json.dumps({"mode": "offline_plan", "plan_sha256": E.M.C.digest(raw.decode()), "engine_calls": 0,
                      "writes": 0, "proof_phases": list(PHASES), "live_execution_enabled": False}))


if __name__ == "__main__":
    main()
