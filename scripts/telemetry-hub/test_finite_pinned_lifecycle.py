"""Finite production-shaped model tests with synthetic snapshots and fake Engine."""
import contextlib
import copy
import importlib.util
import io
import json
import stat
from pathlib import Path
import unittest
from unittest.mock import patch


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    loaded = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(loaded)
    return loaded


F = module("finite_model", "finite-pinned-lifecycle.py")
L = module("finite_fake_engine", "test_pinned_engine_lifecycle.py")
S = module("finite_fake_snapshot", "test_sync_mounted_sources.py")


def fixture():
    engine = L.FakeEngine()
    baseline, old, new_map = S.fixture()
    new = F.E.M.replacement(old, new_map, baseline)
    snapshot = {"old_sha256": F.E.M.C.digest(old), "new_sha256": F.E.M.C.digest(new),
                "old_map_sha256": baseline["old_map_sha256"], "new_map_sha256": baseline["new_map_sha256"],
                "new_members": sorted(baseline["new_members"])}
    plan = {"schema": F.SCHEMA, "lifecycle": engine.manifest(), "snapshot": snapshot,
            "reservation_sha256": F.E.sha({"synthetic": "one-writer-reservation"}),
            "rollback_plan_sha256": F.E.sha(F.recovery_plan(engine.manifest(), snapshot)),
            "limits": {"total_seconds": 120, "phase_seconds": 10, "health_checks": 3}}
    return plan, engine, old, new


class Proofs:
    def __init__(self, plan, engine, old, new):
        self.plan, self.engine, self.old, self.new = plan, engine, old, new
        self.calls = []
        self.change = lambda name, value: None
        self.fail = None
        self.delay = {}
        self.old_identity = self.identity(old, 10)
        self.new_identity = self.identity(new, 11)
        self.journal = {"device": 2, "logical_end": 100, "offset": 90, "dead_letter_bytes": 0,
                        "pending_size": 0, "volume_sha256": plan["lifecycle"]["volume_sha256"],
                        "files": {"journal": [2, 20, 10001, 10001, stat.S_IFREG | 0o600, 100, 1, 1, 1], "dead_letter": None,
                                  "base_state": {"stat": [2, 21, 10001, 10001, stat.S_IFREG | 0o600, 39, 1, 1, 1], "sha256": F.E.sha("base")},
                                  "sentry_offset": {"stat": [2, 22, 10001, 10001, stat.S_IFREG | 0o600, 13, 1, 1, 1], "sha256": F.E.sha("offset")}}}

    def identity(self, raw, inode):
        return {"device": 1, "inode": inode, "uid": 10001, "gid": 10001, "mode": 0o600, "size": len(raw.encode())}

    def invoke(self, name, context, budget):
        budget.remaining()
        self.calls.append(name)
        if self.fail == name:
            raise RuntimeError("synthetic private failure detail")
        if name == "preflight-recovery":
            value = {"old_snapshot": self.old, "new_snapshot": self.new, "snapshot_backup_readback": self.old,
                     "inspect_backup_readback": context["inspect"], "payload_backup_readback": context["payload"],
                     "rollback_plan": F.recovery_plan(self.plan["lifecycle"], self.plan["snapshot"]),
                     "snapshot_identity": self.old_identity, "reservation_sha256": self.plan["reservation_sha256"]}
        elif name == "stopped-transition":
            value = {"before_snapshot": self.old, "after_snapshot": self.new, "before_identity": self.old_identity,
                     "after_identity": self.new_identity, "journal_before": copy.deepcopy(self.journal), "journal_after": copy.deepcopy(self.journal),
                     "replacement_count": 1, "reservation_sha256": self.plan["reservation_sha256"]}
        else:
            value = {"container_id": self.engine.new_id, "mounted_snapshot": self.new, "snapshot_identity": self.new_identity,
                     "journal": self.journal, "reservation_sha256": self.plan["reservation_sha256"]}
        value = copy.deepcopy(value)
        self.change(name, value)
        self.engine.time += self.delay.get(name, 0)
        return value


class Receipts:
    def __init__(self):
        self.values = {}
        self.fail = None
        self.ack_change = lambda value: None

    def __call__(self, name, value):
        if self.fail and self.fail in name:
            raise RuntimeError("synthetic private receipt failure")
        if name in self.values:
            raise AssertionError("exclusive receipt overwritten")
        self.values[name] = copy.deepcopy(value)
        ack = {"sha256": F.E.sha(value), "durable_readback": True}
        self.ack_change(ack)
        return ack


class FiniteTests(unittest.TestCase):
    def candidate(self, cls=F.FiniteLifecycle):
        plan, engine, old, new = fixture()
        proofs, receipts = Proofs(plan, engine, old, new), Receipts()
        candidate = cls(plan, engine, proofs=proofs, receipt=receipts,
                        clock=lambda: engine.time, pause=lambda seconds: setattr(engine, "time", engine.time + seconds))
        return candidate, engine, proofs, receipts

    def test_complete_exact_model_and_proof_receipt_order(self):
        candidate, engine, proofs, receipts = self.candidate()
        result = candidate.run()
        self.assertEqual(result["mode"], "offline_injected_model")
        self.assertFalse(result["live_execution_enabled"])
        self.assertEqual(result["logical_engine_requests"], 26)
        self.assertEqual(result["logical_engine_request_limit"], 36)
        self.assertEqual(proofs.calls, list(F.PHASES))
        self.assertEqual([method for method, _ in engine.mutations], ["POST", "DELETE", "POST", "POST"])
        names = list(receipts.values)
        recovery = next(index for index, name in enumerate(names) if "preflight-recovery-proof" in name)
        stop = next(index for index, name in enumerate(names) if "stop-intent" in name)
        self.assertLess(recovery, stop)
        self.assertTrue(any("prestart-proof" in name for name in names))
        self.assertEqual(len(receipts.values), 18)
        with self.assertRaises(F.Stop):
            candidate.transport.request("GET", F.E.PREFIX + "/containers/" + engine.new_id + "/json")

    def test_exact_route_body_and_query_refusal_before_engine_access(self):
        for method, path, body in (
                ("DELETE", "/volumes/existing-journal?force=false", None),
                ("POST", "/containers/" + "a" * 64 + "/stop?t=16", None),
                ("DELETE", "/containers/" + "a" * 64 + "?v=true&force=false&link=false", None),
                ("GET", "/containers/" + "a" * 64 + "/archive?path=/run/secrets", None),
                ("GET", "/info", {}),
                ("POST", "/containers/create?name=unreviewed", {})):
            candidate, engine, _, _ = self.candidate()
            candidate.deadline = F.E.Deadline(candidate.clock, 120)
            with self.assertRaises(F.Stop):
                candidate.transport.request(method, F.E.PREFIX + path, body)
            self.assertEqual(engine.calls, [])

    def test_unreleased_stop_is_refused_even_on_allowlisted_route(self):
        candidate, engine, _, _ = self.candidate()
        candidate.deadline = F.E.Deadline(candidate.clock, 120)
        with self.assertRaises(F.Stop):
            candidate.transport.request("POST", F.E.PREFIX + "/containers/" + engine.old_id + "/stop?t=15")
        self.assertEqual(engine.calls, [])

    def test_create_payload_mutation_after_recovery_is_not_forwarded(self):
        class ChangedPayload(F.FiniteLifecycle):
            def stopped_transition(self):
                super().stopped_transition()
                self.payload["Env"].append("CHANGED=1")
        candidate, engine, _, _ = self.candidate(ChangedPayload)
        with self.assertRaises(F.Stop):
            candidate.run()
        self.assertEqual(len(engine.mutations), 2)
        self.assertFalse(any("/containers/create?" in path for _, path in engine.mutations))

    def test_each_proof_failure_and_timeout_prevents_later_mutations(self):
        for phase, mutations in zip(F.PHASES, (0, 1, 3, 4)):
            for timed_out in (False, True):
                with self.subTest(phase=phase, timed_out=timed_out):
                    candidate, engine, proofs, _ = self.candidate()
                    if timed_out:
                        proofs.delay[phase] = 10
                    else:
                        proofs.fail = phase
                    with self.assertRaises(F.Stop) as stopped:
                        candidate.run()
                    self.assertNotIn("private failure detail", str(stopped.exception))
                    self.assertEqual(len(engine.mutations), mutations)
                    self.assertEqual(proofs.calls.count(phase), 1)
                    with self.assertRaises(F.Stop):
                        candidate.run()
                    self.assertEqual(len(engine.mutations), mutations)

    def test_missing_or_corrupt_recovery_backup_prevents_stop(self):
        for field in ("snapshot_backup_readback", "inspect_backup_readback", "payload_backup_readback", "rollback_plan"):
            candidate, engine, proofs, _ = self.candidate()
            proofs.change = lambda name, value: value.update({field: "corrupt"}) if name == "preflight-recovery" else None
            with self.assertRaises(F.Stop):
                candidate.run()
            self.assertEqual(engine.mutations, [])

    def test_reviewed_new_hash_cannot_change_preserved_sentry_fields(self):
        plan, engine, old, new = fixture()
        changed = json.loads(new)
        changed["SENTRY_OTLP_ENDPOINT"] = "https://changed.invalid/otlp"
        changed = json.dumps(changed, separators=(",", ":"))
        plan["snapshot"]["new_sha256"] = F.E.M.C.digest(changed)
        proofs = Proofs(plan, engine, old, changed)
        candidate = F.FiniteLifecycle(plan, engine, proofs=proofs, receipt=Receipts(), clock=lambda: engine.time)
        with self.assertRaises(F.Stop):
            candidate.run()
        self.assertEqual(engine.mutations, [])

    def test_custody_compaction_and_stopped_writer_drift_prevent_removal(self):
        changes = (
            lambda value: value["before_identity"].update(device=True),
            lambda value: value["after_identity"].update(uid=0),
            lambda value: value["after_identity"].update(inode=10),
            lambda value: value["journal_after"].update(logical_end=101),
            lambda value: value["journal_after"].update(pending_size=1),
            lambda value: value.update(replacement_count=2),
        )
        for change in changes:
            candidate, engine, proofs, _ = self.candidate()
            proofs.change = lambda name, value: change(value) if name == "stopped-transition" else None
            with self.assertRaises(F.Stop):
                candidate.run()
            self.assertEqual(len(engine.mutations), 1)
            self.assertIn(engine.old_id, engine.containers)

    def test_stopped_mount_or_journal_drift_prevents_start(self):
        for change in (lambda value: value.update(mounted_snapshot="old bind inode"),
                       lambda value: value["snapshot_identity"].update(device=True),
                       lambda value: value["journal"].update(offset=91),
                       lambda value: value.update(container_id="d" * 64)):
            candidate, engine, proofs, _ = self.candidate()
            proofs.change = lambda name, value: change(value) if name == "prestart" else None
            with self.assertRaises(F.Stop):
                candidate.run()
            self.assertEqual(len(engine.mutations), 3)
            self.assertFalse(engine.containers[engine.new_id]["State"]["Running"])

    def test_poststart_journal_regression_or_volume_change_is_not_success(self):
        for change in ({"offset": 89}, {"logical_end": 99}, {"device": 3}, {"dead_letter_bytes": 1},
                       {"volume_sha256": "0" * 64}, {"pending_size": 1}):
            candidate, engine, proofs, _ = self.candidate()
            proofs.change = lambda name, value: value["journal"].update(change) if name == "poststart" else None
            with self.assertRaises(F.Stop):
                candidate.run()
            self.assertEqual(len(engine.mutations), 4)

    def test_poststart_journal_can_advance_on_same_volume(self):
        candidate, _, proofs, _ = self.candidate()
        proofs.change = lambda name, value: value["journal"].update(logical_end=120, offset=100) if name == "poststart" else None
        self.assertFalse(candidate.run()["live_execution_enabled"])

    def test_reservation_change_at_each_phase_is_terminal(self):
        for phase, mutations in zip(F.PHASES, (0, 1, 3, 4)):
            candidate, engine, proofs, _ = self.candidate()
            proofs.change = lambda name, value: value.update(reservation_sha256="0" * 64) if name == phase else None
            with self.assertRaises(F.Stop):
                candidate.run()
            self.assertEqual(len(engine.mutations), mutations)

    def test_receipt_ack_and_stop_response_failures_do_not_continue(self):
        for ack_change in (lambda value: value.update(sha256="0" * 64), lambda value: value.update(durable_readback=False),
                           lambda value: value.update(durable_readback=1)):
            candidate, engine, _, receipts = self.candidate()
            receipts.ack_change = ack_change
            with self.assertRaises(F.Stop):
                candidate.run()
            self.assertEqual(engine.mutations, [])
        candidate, engine, _, receipts = self.candidate()
        receipts.fail = "mutation-response-0"
        with self.assertRaises(F.Stop):
            candidate.run()
        self.assertEqual(len(engine.mutations), 1)

    def test_slow_receipt_and_whole_run_deadline_prevent_later_actions(self):
        candidate, engine, _, receipts = self.candidate()
        receipts.ack_change = lambda value: setattr(engine, "time", engine.time + 10)
        with self.assertRaises(F.Stop):
            candidate.run()
        self.assertEqual(engine.mutations, [])
        plan, engine, old, new = fixture()
        plan["limits"]["total_seconds"] = 20
        proofs = Proofs(plan, engine, old, new)
        proofs.delay = {name: 9 for name in F.PHASES}
        candidate = F.FiniteLifecycle(plan, engine, proofs=proofs, receipt=Receipts(), clock=lambda: engine.time)
        with self.assertRaises(F.Stop):
            candidate.run()
        self.assertEqual(len(engine.mutations), 3)

    def test_warning_body_is_privately_preserved_before_rejection(self):
        candidate, engine, _, receipts = self.candidate()
        engine.warnings = ["synthetic warning retained for reconciliation"]
        with self.assertRaises(F.Stop):
            candidate.run()
        self.assertEqual(len(engine.mutations), 3)
        receipt = next(value for name, value in receipts.values.items() if "mutation-response-2" in name)
        self.assertEqual(receipt["response"]["Warnings"], engine.warnings)

    def test_unexpected_status_after_landed_create_is_preserved_and_terminal(self):
        candidate, engine, _, receipts = self.candidate()
        original = engine.request
        def request(method, path, body=None):
            status, value = original(method, path, body)
            return (202, value) if "/containers/create?" in path else (status, value)
        engine.request = request
        with self.assertRaises(F.Stop):
            candidate.run()
        self.assertEqual(len(engine.mutations), 3)
        self.assertIn(engine.new_id, engine.containers)
        receipt = next(value for name, value in receipts.values.items() if "mutation-response-2" in name)
        self.assertEqual(receipt["status"], 202)

    def test_every_unconfirmed_mutation_is_single_attempt_and_instance_is_sealed(self):
        for index in range(1, 5):
            candidate, engine, _, _ = self.candidate()
            engine.fail_method = index
            with self.assertRaises(F.Stop):
                candidate.run()
            self.assertEqual(len(engine.mutations), index)
            with self.assertRaises(F.Stop):
                candidate.run()
            self.assertEqual(len(engine.mutations), index)

    def test_health_request_budget_is_finite_even_if_clock_does_not_advance(self):
        candidate, engine, _, _ = self.candidate()
        engine.health = "starting"
        candidate.original_pause = lambda seconds: None
        with self.assertRaises(F.Stop):
            candidate.run()
        self.assertEqual(len(engine.calls), 30)
        self.assertEqual(engine.time, 0)
        self.assertEqual(len(engine.mutations), 4)

    def test_real_backend_still_refuses_allowlisted_mutation_without_socket(self):
        candidate, engine, _, _ = self.candidate()
        candidate.deadline = F.E.Deadline(candidate.clock, 120)
        candidate.transport.transport = F.E.ReadOnlyEngine(expected_daemon=candidate.m["daemon_sha256"])
        candidate.transport.release_next()
        with patch.object(F.E, "UnixConnection") as socket:
            with self.assertRaises(F.Stop):
                candidate.transport.request("POST", F.E.PREFIX + "/containers/" + engine.old_id + "/stop?t=15")
            socket.assert_not_called()

    def test_default_plan_and_execute_never_construct_engine_or_read_secrets(self):
        plan, _, _, _ = fixture()
        output = io.StringIO()
        with patch.object(F.sys, "argv", ["finite-pinned-lifecycle.py", "--plan", "/synthetic/plan"]), \
                patch.object(F.Path, "read_bytes", return_value=json.dumps(plan).encode()), \
                patch.object(F.E, "ReadOnlyEngine") as engine, contextlib.redirect_stdout(output):
            F.main()
            engine.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())["engine_calls"], 0)
        with patch.object(F.sys, "argv", ["finite-pinned-lifecycle.py", "--plan", "/synthetic/plan", "--execute"]), \
                patch.object(F.Path, "read_bytes") as read, patch.object(F.E, "ReadOnlyEngine") as engine, \
                contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as stopped:
                F.main()
            self.assertEqual(stopped.exception.code, 2)
            read.assert_not_called()
            engine.assert_not_called()


if __name__ == "__main__":
    unittest.main()
