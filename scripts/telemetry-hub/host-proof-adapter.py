#!/usr/bin/env python3
"""Scoped filesystem proof candidate; no CLI releases live execution."""
from __future__ import annotations
import argparse
import copy
import fcntl
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import time

SPEC = importlib.util.spec_from_file_location("finite_host_model", Path(__file__).with_name("finite-pinned-lifecycle.py"))
F = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(F)
E, Stop = F.E, F.Stop
SNAPSHOT_TARGET = "/run/secrets/telemetry-hub.json"
STAGE = ".telemetry-hub-stage-reviewed"
LEASE = ".telemetry-hub-operation-lease.json"
MAX_PRIVATE = 8 * E.MAX_RESPONSE


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def identity(info):
    return {"device": info.st_dev, "inode": info.st_ino, "uid": info.st_uid, "gid": info.st_gid,
            "mode": stat.S_IMODE(info.st_mode), "size": info.st_size}


def signature(info):
    return (info.st_dev, info.st_ino, info.st_uid, info.st_gid, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


def directory_identity(info):
    return {key: value for key, value in identity(info).items() if key != "size"}


def path(value):
    if (not isinstance(value, str) or not value.startswith("/") or len(value) > 4096
            or str(PurePosixPath(value)) != value or ".." in PurePosixPath(value).parts):
        raise Stop("exact absolute scoped path required")
    return value


def name(value):
    if not isinstance(value, str) or value in (".", "..") or not re.fullmatch(r"[A-Za-z0-9_.-]{1,128}", value):
        raise Stop("fixed local file name required")
    return value


class Directory:
    """Held no-symlink directory descriptor, revalidated against its reviewed path."""
    def __init__(self, location, pin):
        self.path, self.pin, self.fd = path(location), copy.deepcopy(pin), None
        self.closed = False
        F.exact(pin, ("device", "inode", "uid", "gid", "mode"), "exact directory pin required")
        if (any(type(value) is not int or value < 0 for value in pin.values()) or pin["inode"] == 0
                or pin["mode"] not in (0o700, 0o755)):
            raise Stop("invalid reviewed directory pin")

    def check(self, budget):
        if self.closed:
            raise Stop("scoped directory is closed")
        budget.remaining()
        current = E.M.directory_fd(self.path)
        try:
            if directory_identity(os.fstat(current)) != self.pin:
                raise Stop("reviewed directory path changed")
            if self.fd is None:
                self.fd, current = current, None
            if directory_identity(os.fstat(self.fd)) != self.pin:
                raise Stop("held directory identity changed")
        finally:
            if current is not None:
                os.close(current)
        budget.remaining()

    def metadata(self, filename, owner, budget, *, limit=E.MAX_RESPONSE, missing=False):
        self.check(budget)
        try:
            info = os.stat(name(filename), dir_fd=self.fd, follow_symlinks=False)
        except FileNotFoundError:
            if missing:
                return None
            raise
        if (not stat.S_ISREG(info.st_mode) or (info.st_uid, info.st_gid) != tuple(owner)
                or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or not 0 <= info.st_size <= limit):
            raise Stop("scoped regular-file custody mismatch")
        budget.remaining()
        return info

    def read(self, filename, owner, budget, *, limit=E.MAX_RESPONSE, with_signature=False):
        before = self.metadata(filename, owner, budget, limit=limit)
        fd = os.open(name(filename), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=self.fd)
        try:
            if signature(os.fstat(fd)) != signature(before):
                raise Stop("scoped file changed before read")
            chunks, size = [], 0
            while True:
                budget.remaining()
                chunk = os.read(fd, min(65536, limit + 1 - size))
                budget.remaining()
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > limit:
                    raise Stop("scoped file exceeds read bound")
            if (size != before.st_size or signature(os.fstat(fd)) != signature(before)
                    or signature(os.stat(filename, dir_fd=self.fd, follow_symlinks=False)) != signature(before)):
                raise Stop("scoped file changed while reading")
            self.check(budget)
            result = (b"".join(chunks).decode("utf-8"), identity(before))
            return (*result, signature(before)) if with_signature else result
        finally:
            os.close(fd)

    def write(self, filename, raw, owner, budget, *, limit=MAX_PRIVATE, with_signature=False):
        self.check(budget)
        data = raw.encode("utf-8")
        if not 0 < len(data) <= limit:
            raise Stop("private write exceeds bound")
        fd = os.open(name(filename), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600, dir_fd=self.fd)
        try:
            os.fchmod(fd, 0o600)
            if (os.fstat(fd).st_uid, os.fstat(fd).st_gid) != tuple(owner):
                os.fchown(fd, *owner)
            offset = 0
            while offset < len(data):
                budget.remaining()
                count = os.write(fd, data[offset:])
                budget.remaining()
                if count <= 0:
                    raise Stop("private write incomplete")
                offset += count
            os.fsync(fd)
            budget.remaining()
        finally:
            os.close(fd)
        os.fsync(self.fd)
        budget.remaining()
        readback, observed, observed_signature = self.read(filename, owner, budget, limit=limit, with_signature=True)
        if readback != raw:
            raise Stop("private file readback differs")
        return (observed, observed_signature) if with_signature else observed

    def close(self):
        self.closed = True
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None


class DurableReceipts:
    """Exclusive 0600 files, file/directory fsync, exact bounded readback, no cleanup."""
    def __init__(self, directory, pin, *, clock=time.monotonic):
        if (pin.get("uid"), pin.get("gid"), pin.get("mode")) != (os.getuid(), os.getgid(), 0o700):
            raise Stop("receipt directory must be private and owned by this process")
        self.directory = Directory(directory, pin)
        self.owner, self.clock, self.closed = (os.getuid(), os.getgid()), clock, False
        self.attempts, self.failed = set(), False

    def write(self, phase, data, budget):
        if self.closed or self.failed or phase in self.attempts or len(self.attempts) >= 64 or not re.fullmatch(r"[a-z0-9-]{1,100}", phase):
            self.failed = True
            raise Stop("private receipt phase refused")
        self.attempts.add(phase)
        try:
            raw = canonical(data)
            self.directory.write(phase + ".json", raw, self.owner, budget)
            return {"sha256": E.sha(data), "durable_readback": True}
        except Exception:
            self.failed = True
            raise Stop("durable receipt failed; preserve private partial files") from None

    def readback(self, phase, budget):
        if self.closed:
            raise Stop("private receipt sink is closed")
        raw, _ = self.directory.read(name(phase + ".json"), self.owner, budget, limit=MAX_PRIVATE)
        return E.M.C.decode(raw)

    def __call__(self, phase, data):
        return self.write(phase, data, E.Deadline(self.clock, 30))

    def close(self):
        self.closed = True
        self.directory.close()


class RefusingMountedReader:
    def read(self, container_id, *, running, budget):
        raise Stop("live mounted-container readback is unconditionally unavailable")


class HostProofAdapter:
    """Fixed filesystem phases; no credential client, Engine call or runtime executor."""
    def __init__(self, plan, scope, receipts, *, mounted_reader=None):
        F.validate_plan(plan)
        F.exact(scope, ("snapshot_path", "new_snapshot_path", "reservation_path", "journal_path", "receipt_directory",
                        "owner_session", "snapshot_owner", "journal_owner", "input_owner", "pins"), "exact host scope required")
        self.plan, self.scope, self.receipts = copy.deepcopy(plan), copy.deepcopy(scope), receipts
        self.m = self.plan["lifecycle"]
        for key in ("snapshot_path", "new_snapshot_path", "reservation_path", "journal_path", "receipt_directory"):
            path(scope[key])
        if (not isinstance(scope["owner_session"], str) or not re.fullmatch(r"[A-Za-z0-9_.:-]{4,128}", scope["owner_session"])
                or Path(scope["new_snapshot_path"]).parent != Path(scope["reservation_path"]).parent):
            raise Stop("exact owner and one private input directory required")
        for key in ("snapshot_owner", "journal_owner", "input_owner"):
            value = scope[key]
            if not isinstance(value, list) or len(value) != 2 or any(type(item) is not int or item < 0 for item in value):
                raise Stop("exact file owner pair required")
        F.exact(scope["pins"], ("snapshot", "inputs", "journal", "state", "receipts"), "exact directory pins required")
        locations = {"snapshot": str(Path(scope["snapshot_path"]).parent), "inputs": str(Path(scope["new_snapshot_path"]).parent),
                     "journal": scope["journal_path"], "state": scope["journal_path"] + "/state", "receipts": scope["receipt_directory"]}
        if len(set(locations.values())) != len(locations):
            raise Stop("host scope directories must be distinct")
        self.dirs = {key: Directory(location, scope["pins"][key]) for key, location in locations.items()}
        for key in ("inputs", "journal", "state", "receipts"):
            expected_owner = scope["journal_owner"] if key in ("journal", "state") else scope["input_owner"]
            if scope["pins"][key]["mode"] != 0o700 or [scope["pins"][key]["uid"], scope["pins"][key]["gid"]] != expected_owner:
                raise Stop("private directory owner or mode mismatch")
        if scope["input_owner"] != [os.getuid(), os.getgid()]:
            raise Stop("private input custody must belong to this process")
        if (receipts.directory.path != scope["receipt_directory"] or receipts.directory.pin != scope["pins"]["receipts"]):
            raise Stop("receipt sink differs from reviewed host scope")
        self.reader = RefusingMountedReader() if mounted_reader is None else mounted_reader
        self.phases, self.lease_fd, self.closed, self.failed = [], None, False, False
        self.old_raw = self.new_raw = self.old_identity = None

    def bind_engine(self, engine, manifest):
        if manifest != self.m:
            raise Stop("mounted reader Engine manifest differs")
        binder = getattr(self.reader, "bind_engine", None)
        if binder is not None:
            binder(engine, manifest)

    def reservation(self, budget):
        raw, _ = self.dirs["inputs"].read(Path(self.scope["reservation_path"]).name, self.scope["input_owner"], budget)
        value = E.M.C.decode(raw)
        F.exact(value, ("owner_session", "container_id", "snapshot_path", "journal_path", "acknowledgments"), "exact reservation record required")
        if (value["owner_session"] != self.scope["owner_session"] or value["container_id"] != self.m["old_id"]
                or value["snapshot_path"] != self.scope["snapshot_path"] or value["journal_path"] != self.scope["journal_path"]
                or E.sha(value) != self.plan["reservation_sha256"]):
            raise Stop("reviewed host reservation changed")
        acks = value["acknowledgments"]
        if (not isinstance(acks, list) or len(acks) != 2
                or any(not isinstance(ack, dict) or set(ack) != {"topic", "receipt", "acknowledged"}
                       or ack["acknowledged"] is not True or not isinstance(ack["receipt"], str) or not ack["receipt"] for ack in acks)
                or {ack["topic"] for ack in acks} != {"AFC-600", "Clutch"}):
            raise Stop("exact acknowledged reservations required")
        return E.sha(value)

    def lease(self, budget):
        value = {"owner_session": self.scope["owner_session"], "container_id": self.m["old_id"],
                 "plan_sha256": E.sha(self.plan), "scope_sha256": E.sha(self.scope)}
        self.receipts.write("host-lease-intent", value, budget)
        directory = self.dirs["snapshot"]
        directory.write(LEASE, canonical(value), self.receipts.owner, budget)
        observed = directory.metadata(LEASE, self.receipts.owner, budget, limit=MAX_PRIVATE)
        self.lease_fd = os.open(LEASE, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory.fd)
        if signature(os.fstat(self.lease_fd)) != signature(observed):
            raise Stop("cooperative lease file changed")
        fcntl.flock(self.lease_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        budget.remaining()
        self.receipts.write("host-lease-confirmed", {"lease_sha256": E.sha(value), "identity": identity(observed)}, budget)

    def inspected_scope(self, inspected, identifier, *, running):
        mounts = inspected.get("Mounts", [])
        snapshots = [row for row in mounts if row.get("Destination") == SNAPSHOT_TARGET]
        journals = [row for row in mounts if row.get("Destination") == "/data"]
        if (inspected.get("Id") != identifier or inspected.get("Name") != "/" + self.m["old_name"]
                or inspected.get("State", {}).get("Running") is not running or inspected.get("Image") != self.m["image_id"]
                or running and inspected.get("State", {}).get("Health", {}).get("Status") != "healthy"
                or E.sha(E.M.resolved_invariants(inspected)) != self.m["resolved_sha256"]
                or len(snapshots) != 1 or snapshots[0].get("Type") != "bind" or snapshots[0].get("RW") is not False
                or snapshots[0].get("Source") != self.scope["snapshot_path"]
                or len(journals) != 1 or journals[0].get("Type") != "volume" or journals[0].get("RW") is not True
                or journals[0].get("Source") != self.scope["journal_path"] or journals[0].get("Name") != self.m["volume_name"]):
            raise Stop("host scope differs from pinned Engine context")

    def context(self, context):
        F.exact(context, ("inspect", "payload"), "exact initial Engine context required")
        self.inspected_scope(context["inspect"], self.m["old_id"], running=True)
        if (E.sha(context["payload"]) != self.m["payload_sha256"]
                or context["inspect"]["State"].get("Health", {}).get("Status") != "healthy"):
            raise Stop("initial payload or health changed")

    def snapshot(self, budget):
        return self.dirs["snapshot"].read(Path(self.scope["snapshot_path"]).name, self.scope["snapshot_owner"], budget)

    def journal(self, budget):
        root, state, owner = self.dirs["journal"], self.dirs["state"], self.scope["journal_owner"]
        base_sample = state.read("journal.base.json", owner, budget, limit=4096, with_signature=True)
        offset_sample = state.read("sentry.offset.json", owner, budget, limit=4096, with_signature=True)
        base, _, base_signature = base_sample
        offset, _, offset_signature = offset_sample
        journal = root.metadata("journal.jsonl", owner, budget, limit=128 * E.MAX_RESPONSE)
        dead = root.metadata("dead-letter.jsonl", owner, budget, limit=128 * E.MAX_RESPONSE, missing=True)
        if (state.read("journal.base.json", owner, budget, limit=4096, with_signature=True) != base_sample
                or state.read("sentry.offset.json", owner, budget, limit=4096, with_signature=True) != offset_sample
                or signature(root.metadata("journal.jsonl", owner, budget, limit=128 * E.MAX_RESPONSE)) != signature(journal)):
            raise Stop("journal metadata changed during sample")
        after_dead = root.metadata("dead-letter.jsonl", owner, budget, limit=128 * E.MAX_RESPONSE, missing=True)
        if (dead is None) != (after_dead is None) or dead is not None and signature(dead) != signature(after_dead):
            raise Stop("dead-letter metadata changed during sample")
        base_value, offset_value = E.M.C.decode(base), E.M.C.decode(offset)
        F.exact(base_value, ("base", "nextBase", "pendingSize"), "exact journal base state required")
        F.exact(offset_value, ("offset",), "exact Sentry offset state required")
        if (any(type(value) is not int or not 0 <= value <= 2**53 - 1 for value in (*base_value.values(), *offset_value.values()))
                or base_value["pendingSize"] != 0 or base_value["base"] != base_value["nextBase"]
                or journal.st_dev != root.pin["device"] or dead is not None and dead.st_dev != root.pin["device"]):
            raise Stop("journal compaction or device proof invalid")
        result = {"device": journal.st_dev, "logical_end": base_value["base"] + journal.st_size,
                  "offset": offset_value["offset"], "dead_letter_bytes": 0 if dead is None else dead.st_size,
                  "pending_size": 0, "volume_sha256": self.m["volume_sha256"],
                  "files": {"journal": list(signature(journal)), "dead_letter": None if dead is None else list(signature(dead)),
                            "base_state": {"stat": list(base_signature), "sha256": E.M.C.digest(base)},
                            "sentry_offset": {"stat": list(offset_signature), "sha256": E.M.C.digest(offset)}}}
        if result["offset"] > result["logical_end"] or result["logical_end"] > 2**53 - 1:
            raise Stop("journal offset exceeds logical end")
        return result

    def initial(self, context, budget):
        self.context(context)
        for directory in self.dirs.values():
            directory.check(budget)
        reservation = self.reservation(budget)
        self.lease(budget)
        old, observed = self.snapshot(budget)
        new, _ = self.dirs["inputs"].read(Path(self.scope["new_snapshot_path"]).name, self.scope["input_owner"], budget)
        snapshot = self.plan["snapshot"]
        manifest = {"old_snapshot_sha256": snapshot["old_sha256"], "old_map_sha256": snapshot["old_map_sha256"],
                    "new_map_sha256": snapshot["new_map_sha256"], "new_members": snapshot["new_members"]}
        if E.M.C.digest(new) != snapshot["new_sha256"] or E.M.replacement(old, E.M.snapshot(new)[E.M.C.HUB_MAP], manifest) != new:
            raise Stop("reviewed host snapshot pair changed")
        backups = {"snapshot": old, "inspect": context["inspect"], "payload": context["payload"],
                   "reconstruction": F.recovery_plan(self.m, snapshot)}
        for label, value in backups.items():
            self.receipts.write("backup-" + label, value, budget)
        readbacks = {label: self.receipts.readback("backup-" + label, budget) for label in backups}
        if readbacks != backups or self.reservation(budget) != reservation or self.snapshot(budget) != (old, observed):
            raise Stop("backup readback or host baseline changed")
        self.old_raw, self.new_raw, self.old_identity = old, new, observed
        self.old_signature = signature(self.dirs["snapshot"].metadata(Path(self.scope["snapshot_path"]).name, self.scope["snapshot_owner"], budget))
        return {"old_snapshot": old, "new_snapshot": new, "snapshot_backup_readback": readbacks["snapshot"],
                "inspect_backup_readback": readbacks["inspect"], "payload_backup_readback": readbacks["payload"],
                "rollback_plan": readbacks["reconstruction"], "snapshot_identity": observed, "reservation_sha256": reservation}

    def transition(self, context, budget):
        F.exact(context, ("old_sha256", "new_sha256", "stopped_inspect"), "exact transition context required")
        self.inspected_scope(context["stopped_inspect"], self.m["old_id"], running=False)
        if any(context[key] != self.plan["snapshot"][key] for key in ("old_sha256", "new_sha256")):
            raise Stop("transition context differs from reviewed plan")
        reservation = self.reservation(budget)
        before, before_identity = self.snapshot(budget)
        if ((before, before_identity) != (self.old_raw, self.old_identity)
                or signature(self.dirs["snapshot"].metadata(Path(self.scope["snapshot_path"]).name, self.scope["snapshot_owner"], budget)) != self.old_signature):
            raise Stop("host snapshot changed before transition")
        before_journal = self.journal(budget)
        self.receipts.write("host-snapshot-rename-intent", {"old_sha256": context["old_sha256"], "new_sha256": context["new_sha256"],
                            "before_identity": before_identity, "journal": before_journal}, budget)
        directory = self.dirs["snapshot"]
        staged, staged_signature = directory.write(STAGE, self.new_raw, self.scope["snapshot_owner"], budget,
                                                   limit=E.MAX_RESPONSE, with_signature=True)
        if (self.reservation(budget) != reservation or self.snapshot(budget) != (before, before_identity) or self.journal(budget) != before_journal
                or signature(directory.metadata(Path(self.scope["snapshot_path"]).name, self.scope["snapshot_owner"], budget)) != self.old_signature):
            raise Stop("host compare immediately before rename changed")
        directory.check(budget)
        # Intervening reservation/snapshot/journal reads must not leave the staged
        # pathname trusted from an earlier readback.
        staged_raw, staged_now, signature_now = directory.read(STAGE, self.scope["snapshot_owner"], budget,
                                                             limit=E.MAX_RESPONSE, with_signature=True)
        if (staged_raw != self.new_raw or staged_now != staged or signature_now != staged_signature
                or signature(directory.metadata(STAGE, self.scope["snapshot_owner"], budget)) != staged_signature):
            raise Stop("staged snapshot changed immediately before rename")
        budget.remaining()
        os.replace(STAGE, Path(self.scope["snapshot_path"]).name, src_dir_fd=directory.fd, dst_dir_fd=directory.fd)
        budget.remaining()
        os.fsync(directory.fd)
        budget.remaining()
        after, after_identity = self.snapshot(budget)
        after_journal = self.journal(budget)
        if (after != self.new_raw or after_identity != staged or after_journal != before_journal
                or self.reservation(budget) != reservation):
            raise Stop("snapshot replacement outcome requires reconciliation")
        self.new_signature = signature(directory.metadata(Path(self.scope["snapshot_path"]).name, self.scope["snapshot_owner"], budget))
        result = {"before_snapshot": before, "after_snapshot": after, "before_identity": before_identity,
                  "after_identity": after_identity, "journal_before": before_journal, "journal_after": after_journal,
                  "replacement_count": 1, "reservation_sha256": reservation}
        self.receipts.write("host-snapshot-rename-confirmed", result, budget)
        return result

    def runtime(self, phase, context, budget):
        F.exact(context, ("new_id", "snapshot_sha256", "inspect"), "exact runtime context required")
        identifier = context["new_id"]
        if (not isinstance(identifier, str) or not re.fullmatch(r"[0-9a-f]{64}", identifier) or identifier == self.m["old_id"]
                or context["snapshot_sha256"] != self.plan["snapshot"]["new_sha256"]):
            raise Stop("exact replacement readback identity required")
        self.inspected_scope(context["inspect"], identifier, running=phase == "poststart")
        if phase == "prestart":
            self.new_id = identifier
        elif identifier != self.new_id:
            raise Stop("replacement identity changed after prestart")
        reservation = self.reservation(budget)
        raw = self.reader.read(identifier, running=phase == "poststart", budget=budget)
        budget.remaining()
        if not isinstance(raw, str) or not 0 < len(raw.encode()) <= E.MAX_RESPONSE or raw != self.new_raw:
            raise Stop("actual container snapshot readback differs")
        host_raw, observed = self.snapshot(budget)
        if (host_raw != raw or signature(self.dirs["snapshot"].metadata(Path(self.scope["snapshot_path"]).name,
                                                                     self.scope["snapshot_owner"], budget)) != self.new_signature):
            raise Stop("host and actual container snapshot differ")
        journal = self.journal(budget)
        if self.reservation(budget) != reservation:
            raise Stop("reservation changed during actual readback")
        return {"container_id": identifier, "mounted_snapshot": raw, "snapshot_identity": observed,
                "journal": journal, "reservation_sha256": reservation}

    def invoke(self, phase, context, budget):
        try:
            if self.closed or self.failed or len(self.phases) >= 4 or phase != F.PHASES[len(self.phases)]:
                raise Stop("host proof phase order refused")
            self.phases.append(phase)
            budget.remaining()
            result = (self.initial(context, budget) if phase == "preflight-recovery" else
                      self.transition(context, budget) if phase == "stopped-transition" else self.runtime(phase, context, budget))
            budget.remaining()
            return result
        except Exception:
            self.failed = True
            raise Stop("host proof failed; preserve scoped files and reconcile") from None

    def close(self):
        self.closed = True
        if self.lease_fd is not None:
            os.close(self.lease_fd)
            self.lease_fd = None
        for directory in self.dirs.values():
            directory.close()
        closer = getattr(self.reader, "close", None)
        if closer is not None:
            closer()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.execute:
        print(json.dumps({"status": "stopped", "reason": "live host execution is unconditionally disabled"}), file=sys.stderr)
        raise SystemExit(2)
    print(json.dumps({"mode": "offline_candidate", "filesystem_calls": 0, "engine_calls": 0, "live_execution_enabled": False}))


if __name__ == "__main__":
    main()
