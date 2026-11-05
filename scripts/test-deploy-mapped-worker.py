import importlib.util,io,json,os,re,unittest
from unittest.mock import patch
s=importlib.util.spec_from_file_location("deploy","scripts/deploy-mapped-worker.py");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
sg=importlib.util.spec_from_file_location("guards","scripts/check-worker-guards.py");g=importlib.util.module_from_spec(sg);sg.loader.exec_module(g)
def matrix_workers():
 with open(".github/workflows/worker-deploy.yml") as f:workflow=f.read()
 found=re.search(r"^\s*worker:\s*(\[.*\])\s*$",workflow,re.M)
 if not found:raise AssertionError("worker matrix not found in worker-deploy.yml")
 return json.loads(found.group(1))
class Checks(unittest.TestCase):
 def test_partial_rollout_is_not_exact_receipt(self):
  with patch.object(m,"api",return_value={"deployments":[{"versions":[{"version_id":"a","percentage":50}]}]}):self.assertIsNone(m.deployed_tag("x"))
 def test_exact_tag(self):
  with patch.object(m,"api",side_effect=[{"deployments":[{"versions":[{"version_id":"a","percentage":100}]}]},{"annotations":{"workers/tag":"sha"}}]):self.assertEqual(m.deployed_tag("x"),"sha")
 def test_unconfigured_probe_blocks(self):
  # Target dicts carry no "name" key; the error path must not raise KeyError.
  with self.assertRaisesRegex(RuntimeError,"not configured for unnamed target"):m.probe({})
  with self.assertRaisesRegex(RuntimeError,"not configured for x"):m.probe({"health":None},"x")
 def test_targets_are_explicit(self):
  self.assertNotIn("start-jays-services",m.TARGETS);self.assertNotIn("fleet-share-api",m.TARGETS)
 def test_matrix_workers_are_mapped_with_probes(self):
  workers=matrix_workers()
  self.assertTrue(workers)
  for name in workers:
   self.assertIn(name,m.TARGETS)
   self.assertTrue(m.TARGETS[name].get("health") or m.TARGETS[name].get("probe")=="telemetry",name+" has no approved functional probe")
 def test_auditor_deploys_before_the_inbox_that_reads_it(self):
  workers=matrix_workers()
  self.assertEqual(workers[0],"usage-monitor-receipt-lifecycle-auditor")
  self.assertLess(workers.index("usage-monitor-receipt-lifecycle-auditor"),workers.index("usage-monitor-receipt-inbox"))
  self.assertEqual(m.TARGETS["usage-monitor-receipt-inbox"]["deploy_after"],"usage-monitor-receipt-lifecycle-auditor")
 def test_no_target_needs_the_access_credential_the_workflow_no_longer_passes(self):
  self.assertFalse([n for n,t in m.TARGETS.items() if t.get("access")])
  with open(".github/workflows/worker-deploy.yml") as f:self.assertNotIn("WORKER_HEALTH_ACCESS",f.read())
 def test_expenses_probe_does_not_fetch_the_private_ledger(self):
  self.assertNotIn("health",m.TARGETS["expenses-jays-services"])
 def test_gate_stays_off_and_deploy_job_requires_limits(self):
  with open(".github/workflows/worker-deploy.yml") as f:workflow=f.read()
  self.assertIn("vars.WORKER_DEPLOY_ENABLED == 'true' && github.event_name != 'pull_request'",workflow)
  self.assertIn("scripts/check-worker-guards.py --require-limits",workflow)
 def test_api_request_names_a_client(self):
  with patch.dict(os.environ,{"CLOUDFLARE_API_TOKEN":"t"}),patch("urllib.request.urlopen") as urlopen:
   urlopen.return_value.__enter__.return_value=io.BytesIO(b'{"success":true,"result":{}}')
   m.api("/x")
   self.assertEqual(urlopen.call_args.args[0].get_header("User-agent"),m.USER_AGENT)
 def test_current_main_names_a_client(self):
  with patch.dict(os.environ,{"GITHUB_REPOSITORY":"o/r","GH_TOKEN":"t"}),patch("urllib.request.urlopen") as urlopen:
   urlopen.return_value.__enter__.return_value=io.BytesIO(b'{"object":{"sha":"abc"}}')
   m.current_main()
   self.assertEqual(urlopen.call_args.args[0].get_header("User-agent"),m.USER_AGENT)
 def test_health_probe_names_a_client(self):
  with patch("urllib.request.urlopen") as urlopen:
   response=urlopen.return_value.__enter__.return_value
   response.status=200;response.read=lambda *a:b'{"ok":true}'
   m.probe({"health":"https://x/health","ok":True},"x")
   self.assertEqual(urlopen.call_args.args[0].get_header("User-agent"),m.USER_AGENT)
 def live(self,*items,annotations=None,message=None,earlier=("b","c")):
  """api() stand-in: live version 'a' (number 10) at 100%, then the deployments in earlier, newest first."""
  deployment={"versions":[{"version_id":"a","percentage":100}],"annotations":{"workers/message":message} if message else {}}
  history=[deployment]+[{"versions":[{"version_id":v,"percentage":100}]} for v in earlier]
  def fake(path):
   if path.endswith("/deployments"):return {"deployments":history}
   if "/versions?" in path:return {"items":list(items)}
   if path.endswith("/versions/a"):return {"annotations":annotations,"number":10}
   raise AssertionError(path)
  return patch.object(m,"api",side_effect=fake)
 def test_secret_only_version_walks_back_to_the_tag(self):
  secret={"workers/triggered_by":"secret"}
  with self.live({"id":"newer-undeployed","number":11,"annotations":{"workers/tag":"wrong"}},{"id":"a","number":10,"annotations":secret},{"id":"b","number":9,"annotations":secret},{"id":"c","number":8,"annotations":{"workers/tag":"sha"}},annotations=secret):
   self.assertEqual(m.deployed_tag("x"),"sha")
 def test_walk_stops_at_an_untagged_code_version(self):
  secret={"workers/triggered_by":"secret"}
  with self.live({"id":"a","number":10,"annotations":secret},{"id":"b","number":9,"annotations":{"workers/triggered_by":"version_upload"}},{"id":"c","number":8,"annotations":{"workers/tag":"old"}},annotations=secret):
   self.assertIsNone(m.deployed_tag("x"))
 def test_walk_does_not_claim_a_version_that_was_rolled_back(self):
  # b was deployed, then rolled back to c, and a secret change copied c into a.
  secret={"workers/triggered_by":"secret"}
  with self.live({"id":"a","number":10,"annotations":secret},{"id":"b","number":9,"annotations":{"workers/tag":"bad"}},{"id":"c","number":8,"annotations":{"workers/tag":"good"}},annotations=secret,earlier=("c","b","c")):
   self.assertIsNone(m.deployed_tag("x"))
 def test_walk_does_not_claim_an_upload_that_was_never_deployed(self):
  secret={"workers/triggered_by":"secret"}
  with self.live({"id":"a","number":10,"annotations":secret},{"id":"b","number":9,"annotations":{"workers/tag":"never-live"}},{"id":"c","number":8,"annotations":{"workers/tag":"live"}},annotations=secret,earlier=("c",)):
   self.assertIsNone(m.deployed_tag("x"))
 def test_walk_passes_a_label_deployment_on_the_same_version(self):
  # The watchdog's label is a second deployment of the live version, not older code.
  secret={"workers/triggered_by":"secret"}
  with self.live({"id":"a","number":10,"annotations":secret},{"id":"b","number":9,"annotations":{"workers/tag":"sha"}},annotations=secret,earlier=("a","b")):
   self.assertEqual(m.deployed_tag("x"),"sha")
 def test_untagged_settings_upload_is_not_walked(self):
  with self.live(annotations={"workers/triggered_by":"upload"}):self.assertIsNone(m.deployed_tag("x"))
 def test_guard_tripped_on_deployment_message(self):
  with self.live(annotations={},message="GUARD-TRIPPED d1 rows"):self.assertTrue(m.guard_tripped("x"))
 def test_guard_tripped_on_version_message(self):
  with self.live(annotations={"workers/message":"GUARD-TRIPPED d1 rows"}):self.assertTrue(m.guard_tripped("x"))
 def test_guard_tripped_under_a_secret_version(self):
  secret={"workers/triggered_by":"secret"}
  with self.live({"id":"a","number":10,"annotations":secret},{"id":"b","number":9,"annotations":{"workers/message":"GUARD-TRIPPED x","workers/triggered_by":"version_upload"}},annotations=secret):
   self.assertTrue(m.guard_tripped("x"))
 def test_ordinary_message_is_not_a_trip(self):
  with self.live(annotations={"workers/message":"main abc"},message="Automatic deployment on upload."):self.assertFalse(m.guard_tripped("x"))
 def run_main(self,name="expenses-jays-services",tag=None,tripped=(False,False),changed=True,source="wrangler",final_tag="sha1"):
  """Run main() with every external call mocked; returns the mocks that matter."""
  tags=[tag,final_tag] if isinstance(tag,(str,type(None))) else list(tag)
  with patch.object(m.sys,"argv",["deploy",name]),\
   patch.object(m.subprocess,"check_output",return_value="sha1\n"),\
   patch.object(m,"current_main",return_value="sha1"),\
   patch.object(m,"guard_tripped",side_effect=list(tripped)),\
   patch.object(m,"deployed_tag",side_effect=tags),\
   patch.object(m,"worker_changed",return_value=changed),\
   patch.object(m,"last_deployed_from",return_value=source),\
   patch.object(m,"probe") as probe,\
   patch.object(m.subprocess,"run") as run:
   try:m.main()
   finally:self.calls=(probe,run)
  return self.calls
 def test_tripped_worker_is_refused_before_probe_or_upload(self):
  with self.assertRaisesRegex(SystemExit,"usage guard"):self.run_main(tripped=(True,))
  probe,run=self.calls
  probe.assert_not_called();run.assert_not_called()
 def test_trip_during_the_run_is_refused_before_upload(self):
  with self.assertRaisesRegex(SystemExit,"usage guard"):self.run_main(tripped=(False,True))
  probe,run=self.calls
  run.assert_not_called()
 def test_deploy_uses_strict_and_tag_when_last_change_was_wrangler(self):
  probe,run=self.run_main()
  argv=run.call_args.args[0]
  self.assertIn("--strict",argv);self.assertIn("--keep-vars",argv)
  self.assertEqual(argv[argv.index("--tag")+1],"sha1")
  self.assertEqual(probe.call_args_list[0].kwargs,{"before_upload":True})
  self.assertEqual(probe.call_args.kwargs,{"after_upload":True})
 def test_deploy_drops_strict_only_after_a_script_api_change(self):
  probe,run=self.run_main(source="api")
  self.assertNotIn("--strict",run.call_args.args[0])
 def test_dashboard_edit_keeps_strict(self):
  probe,run=self.run_main(source="dash")
  self.assertIn("--strict",run.call_args.args[0])
 def test_inbox_refuses_when_auditor_is_behind(self):
  with self.assertRaisesRegex(SystemExit,"ahead of it"):
   self.run_main(name="usage-monitor-receipt-inbox",tag=["old","old"],changed=True)
  probe,run=self.calls
  probe.assert_not_called();run.assert_not_called()
 def test_inbox_deploys_when_auditor_is_current(self):
  probe,run=self.run_main(name="usage-monitor-receipt-inbox",tag=["old","sha1","sha1"],changed=True)
  self.assertEqual(run.call_count,2)
  self.assertIn("workers/receipt-inbox/wrangler.jsonc",run.call_args.args[0])
 def rows(self,*rows):
  return patch.object(m,"telemetry_rows",return_value=[{"sum":{"requests":n},"dimensions":{"status":s,"scriptVersion":v}} for s,v,n in rows])
 def test_telemetry_passes_on_clean_live_version(self):
  with patch.object(m,"live_version",return_value="a"),self.rows(("success","a",4),("scriptThrewException","old",9),("clientDisconnected","a",1)):
   m.probe({"probe":"telemetry"},"x")
 def test_telemetry_fails_on_live_version_exception(self):
  with patch.object(m,"live_version",return_value="a"),self.rows(("success","a",4),("scriptThrewException","a",1)):
   with self.assertRaisesRegex(RuntimeError,"1 failed invocations"):m.probe({"probe":"telemetry"},"x")
   with self.assertRaisesRegex(RuntimeError,"1 failed invocations"):m.probe({"probe":"telemetry"},"x",after_upload=True)
 def test_telemetry_requires_recent_invocations_except_right_after_upload(self):
  with patch.object(m,"live_version",return_value="a"),self.rows():
   with self.assertRaisesRegex(RuntimeError,"No invocations"):m.probe({"probe":"telemetry"},"x")
   m.probe({"probe":"telemetry"},"x",after_upload=True)
 def test_run_with_nothing_to_deploy_still_judges_the_telemetry(self):
  # Through main: the half-hourly run with no upload applies the no-invocations rule and the tolerance.
  thrown=[("success","a",5),("scriptThrewException","a",13)]
  for tag,changed,rows,why in (("sha1",True,[],"No invocations"),("a"*40,False,[],"No invocations"),("sha1",True,thrown,"13 failed invocations")):
   with self.subTest(tag=tag,why=why),patch.object(m.sys,"argv",["deploy","expenses-jays-services"]),\
    patch.object(m.subprocess,"check_output",return_value="sha1\n"),\
    patch.object(m,"current_main",return_value="sha1"),\
    patch.object(m,"guard_tripped",return_value=False),\
    patch.object(m,"deployed_tag",return_value=tag),\
    patch.object(m,"worker_changed",return_value=changed),\
    patch.object(m,"live_version",return_value="a"),\
    self.rows(*rows),\
    patch.object(m.subprocess,"run") as run:
    with self.assertRaisesRegex(RuntimeError,why):m.main()
    run.assert_not_called()
 def test_telemetry_failure_does_not_hold_back_the_upload_that_fixes_it(self):
  with patch.object(m,"live_version",return_value="a"),self.rows(("scriptThrewException","a",1)):
   m.probe({"probe":"telemetry"},"x",before_upload=True)
  with patch.object(m,"live_version",return_value="a"),self.rows():
   m.probe({"probe":"telemetry"},"x",before_upload=True)
 def test_telemetry_read_failure_still_stops_before_upload(self):
  with patch.object(m,"live_version",return_value="a"),patch.object(m,"telemetry_rows",side_effect=RuntimeError("Cloudflare telemetry read rejected")):
   with self.assertRaisesRegex(RuntimeError,"read rejected"):m.probe({"probe":"telemetry"},"x",before_upload=True)
 def test_http_probe_still_fails_closed_before_upload(self):
  with patch("urllib.request.urlopen") as urlopen:
   response=urlopen.return_value.__enter__.return_value
   response.status=200;response.read=lambda *a:b'{"ok":false}'
   with self.assertRaisesRegex(RuntimeError,"not ready"):m.probe({"health":"https://x/health","ok":True},"x",before_upload=True)
 def test_telemetry_fails_closed_on_partial_rollout(self):
  with patch.object(m,"live_version",return_value=None):
   with self.assertRaisesRegex(RuntimeError,"not at 100%"):m.probe({"probe":"telemetry"},"x",after_upload=True)
 def test_telemetry_rows_reads_graphql_and_rejects_errors(self):
  with patch.dict(os.environ,{"CLOUDFLARE_API_TOKEN":"t"}),patch("urllib.request.urlopen") as urlopen:
   urlopen.return_value.__enter__.return_value=io.BytesIO(b'{"data":{"viewer":{"accounts":[{"workersInvocationsAdaptive":[]}]}},"errors":null}')
   self.assertEqual(m.telemetry_rows("x"),[])
   request=urlopen.call_args.args[0]
   self.assertEqual(request.full_url,"https://api.cloudflare.com/client/v4/graphql")
   self.assertEqual(request.get_header("User-agent"),m.USER_AGENT)
   urlopen.return_value.__enter__.return_value=io.BytesIO(b'{"data":null,"errors":[{"message":"budget depleted"}]}')
   with self.assertRaisesRegex(RuntimeError,"telemetry read rejected: budget depleted"):m.telemetry_rows("x")
   urlopen.return_value.__enter__.return_value=io.BytesIO(b'<html>not json</html>')
   with self.assertRaisesRegex(RuntimeError,"telemetry read rejected: the answer is not JSON"):m.telemetry_rows("x")
 def test_telemetry_result_fails_closed_on_every_malformed_answer(self):
  def account(rows):return {"data":{"viewer":{"accounts":[{"workersInvocationsAdaptive":rows}]}}}
  for body,why in (
    ([],"not an object"),(None,"not an object"),
    ({"data":None},"no data"),({},"no data"),({"data":[]},"no data"),
    ({"data":{"viewer":None}},"no data"),({"data":{"viewer":{}}},"no data"),({"data":{"viewer":{"accounts":None}}},"no data"),
    ({"data":{"viewer":{"accounts":[]}}},"may lack Account Analytics Read"),
    ({"data":{"viewer":{"accounts":[None]}}},"may lack Account Analytics Read"),
    ({"data":{"viewer":{"accounts":[{}]}}},"no invocation rows"),
    (account(None),"no invocation rows"),(account({}),"no invocation rows"),
    (account([None]),"row is malformed"),(account([{}]),"row is malformed"),
    (account([{"sum":{"requests":None},"dimensions":{"status":"success","scriptVersion":"a"}}]),"row is malformed"),
    (account([{"sum":{"requests":1},"dimensions":{"status":"success"}}]),"row is malformed"),
    ({"errors":["odd"],"data":None},"unreadable error"),({"errors":"odd"},"unreadable error"),
  ):
   with self.subTest(body=body):
    with self.assertRaisesRegex(RuntimeError,"telemetry read rejected: .*"+why):m.telemetry_result(body)
 def test_telemetry_result_keeps_an_empty_row_list_for_the_probe_to_judge(self):
  self.assertEqual(m.telemetry_result({"data":{"viewer":{"accounts":[{"workersInvocationsAdaptive":[]}]}}}),[])
 def test_telemetry_null_data_stops_a_run_before_upload(self):
  # Through the real probe: a read that returns no account must not pass as a quiet Worker.
  with patch.dict(os.environ,{"CLOUDFLARE_API_TOKEN":"t"}),patch.object(m,"live_version",return_value="a"),patch("urllib.request.urlopen") as urlopen:
   urlopen.return_value.__enter__.return_value=io.BytesIO(b'{"data":{"viewer":{"accounts":[]}}}')
   with self.assertRaisesRegex(RuntimeError,"may lack Account Analytics Read"):m.probe({"probe":"telemetry"},"x",before_upload=True)
 def test_flaky_rethrowing_sync_stays_green_within_its_tolerance(self):
  # PR 1902 rethrows sync errors, and the upstream failed about 40 times in 7 days.
  target=m.TARGETS["expenses-jays-services"]
  limit=target["tolerated_exceptions"]
  with patch.object(m,"live_version",return_value="a"),self.rows(("success","a",12),("scriptThrewException","a",limit)):
   m.probe(target,"expenses-jays-services")
  with patch.object(m,"live_version",return_value="a"),self.rows(("success","a",11),("scriptThrewException","a",limit+1)):
   with self.assertRaisesRegex(RuntimeError,str(limit+1)+" failed invocations"):m.probe(target,"expenses-jays-services")
 def test_tolerance_never_covers_limit_failures_or_a_version_that_only_throws(self):
  target={"probe":"telemetry","tolerated_exceptions":12}
  for status in ("exceededCpu","exceededResources","internalError","unknown"):
   with self.subTest(status=status),patch.object(m,"live_version",return_value="a"),self.rows(("success","a",20),(status,"a",1)):
    with self.assertRaisesRegex(RuntimeError,"1 failed invocations"):m.probe(target,"x")
  with patch.object(m,"live_version",return_value="a"),self.rows(("scriptThrewException","a",1)):
   with self.assertRaisesRegex(RuntimeError,"1 failed invocations"):m.probe(target,"x")
   with self.assertRaisesRegex(RuntimeError,"1 failed invocations"):m.probe(target,"x",after_upload=True)
 def test_only_expenses_tolerates_exceptions(self):
  self.assertEqual([n for n,t in m.TARGETS.items() if "tolerated_exceptions" in t],["expenses-jays-services"])
  self.assertEqual(m.TARGETS["expenses-jays-services"]["tolerated_exceptions"],12)
 def test_current_main_reads_main_ref_sha(self):
  with patch.dict(os.environ,{"GITHUB_REPOSITORY":"o/r","GH_TOKEN":"t"}),patch("urllib.request.urlopen") as urlopen:
   urlopen.return_value.__enter__.return_value=io.BytesIO(b'{"object":{"sha":"abc"}}')
   self.assertEqual(m.current_main(),"abc")
   request=urlopen.call_args.args[0]
   self.assertEqual(request.full_url,"https://api.github.com/repos/o/r/git/ref/heads/main")
 def test_current_main_rejects_malformed_response(self):
  with patch.dict(os.environ,{"GITHUB_REPOSITORY":"o/r","GH_TOKEN":"t"}),patch("urllib.request.urlopen") as urlopen:
   urlopen.return_value.__enter__.return_value=io.BytesIO(b'{"message":"Not Found"}')
   with self.assertRaises(KeyError):m.current_main()
 def test_worker_changed_path_relevance(self):
  import subprocess,tempfile
  with tempfile.TemporaryDirectory() as d:
   def git(*a):subprocess.run(["git",*a],cwd=d,check=True,capture_output=True)
   def head():return subprocess.check_output(["git","rev-parse","HEAD"],cwd=d,text=True).strip()
   git("init","-q");git("config","user.email","t@t");git("config","user.name","t")
   open(os.path.join(d,"package.json"),"w").write("{}");git("add",".");git("commit","-qm","init");old=head()
   os.mkdir(os.path.join(d,"ios"));open(os.path.join(d,"ios","x"),"w").write("x");git("add",".");git("commit","-qm","ios")
   self.assertFalse(m.worker_changed(old,head(),cwd=d))
   os.makedirs(os.path.join(d,"workers","receipt-inbox"));open(os.path.join(d,"workers","receipt-inbox","x.mjs"),"w").write("x");git("add",".");git("commit","-qm","w")
   self.assertTrue(m.worker_changed(old,head(),cwd=d))
   self.assertTrue(m.worker_changed("0"*40,head(),cwd=d))
   self.assertTrue(m.worker_changed("",head(),cwd=d))
 def test_worker_paths_stay_inside_workflow_push_filter(self):
  with open(".github/workflows/worker-deploy.yml") as f:workflow=f.read()
  yaml_paths=set(re.findall(r"^\s+-\s+'([^']+)'",workflow,re.M))
  missing=[p for p in m.WORKER_PATHS if p not in yaml_paths]
  self.assertEqual(missing,[],"WORKER_PATHS entries missing from workflow push filter: "+str(missing))
 def test_superseded_main_skips_before_any_mutation(self):
  with patch.object(m.sys,"argv",["deploy","expenses-jays-services"]),\
   patch.object(m.subprocess,"check_output",return_value="old\n"),\
   patch.object(m,"current_main",return_value="new"),\
   patch.object(m,"deployed_tag") as deployed_tag,\
   patch.object(m,"probe") as probe,\
   patch.object(m.subprocess,"run") as run:
   m.main()
  deployed_tag.assert_not_called();probe.assert_not_called();run.assert_not_called()
class GuardChecks(unittest.TestCase):
 GOOD={"name":"w","limits":{"cpu_ms":50,"subrequests":20},"observability":{"enabled":True,"head_sampling_rate":1}}
 def repo(self,config=None,guard=None,raw=None,extra=None):
  import pathlib,tempfile
  d=tempfile.TemporaryDirectory();self.addCleanup(d.cleanup);root=pathlib.Path(d.name)
  (root/"scripts").mkdir();(root/"workers/w").mkdir(parents=True)
  entry={"status":"gated","max_cpu_ms":50,"max_subrequests":20} if guard is None else guard
  target={"command":["wrangler","deploy","--config","workers/w/wrangler.jsonc"]}
  if entry!="absent":target["guard"]=entry
  (root/"scripts/worker-targets.json").write_text(json.dumps({"w":target}))
  (root/"workers/w/wrangler.jsonc").write_text(raw if raw is not None else json.dumps(self.GOOD if config is None else config))
  if extra:
   (root/"workers/z").mkdir();(root/"workers/z/wrangler.jsonc").write_text(json.dumps(extra))
  return root
 def errors(self,**kw):
  require=kw.pop("require_limits",False)
  return g.check(self.repo(**kw),require_limits=require)
 def test_this_repo_passes(self):
  errors,_=g.check(".")
  self.assertEqual(errors,[])
 def test_this_repo_covers_exactly_the_three_workers(self):
  self.assertEqual(set(m.TARGETS),{"expenses-jays-services","usage-monitor-receipt-inbox","usage-monitor-receipt-lifecycle-auditor"})
  for target in m.TARGETS.values():self.assertIn(target["guard"]["status"],g.STATUSES)
 def test_inbox_ceiling_leaves_room_for_large_pdf_mail(self):
  # 200 ms stopped PDF mail from roughly 6.5 MiB, so a config may go to 500 and no further.
  guard=m.TARGETS["usage-monitor-receipt-inbox"]["guard"]
  self.assertEqual((guard["max_cpu_ms"],guard["max_subrequests"]),(500,30))
  errors,_=g.check_limits("i",{"limits":{"cpu_ms":500,"subrequests":30}},guard,True)
  self.assertEqual(errors,[])
  errors,_=g.check_limits("i",{"limits":{"cpu_ms":501,"subrequests":30}},guard,True)
  self.assertTrue(any("over the registry ceiling 500" in e for e in errors))
 def test_clean_config_passes(self):
  self.assertEqual(self.errors(),([],[]))
 def test_missing_limits_fail(self):
  errors,_=self.errors(config={"name":"w","observability":{"head_sampling_rate":1}})
  self.assertTrue(any("no limits.cpu_ms" in e for e in errors));self.assertTrue(any("no limits.subrequests" in e for e in errors))
 def test_pending_limits_are_a_notice_until_required(self):
  guard={"status":"gated","max_cpu_ms":50,"max_subrequests":20,"limits_pending":True}
  config={"name":"w","observability":{"head_sampling_rate":1}}
  errors,notices=self.errors(config=config,guard=guard)
  self.assertEqual(errors,[]);self.assertEqual(len(notices),2)
  errors,_=self.errors(config=config,guard=guard,require_limits=True)
  self.assertEqual(len(errors),2)
 def test_pending_does_not_excuse_a_limit_over_the_ceiling(self):
  guard={"status":"gated","max_cpu_ms":50,"max_subrequests":20,"limits_pending":True}
  errors,_=self.errors(config={**self.GOOD,"limits":{"cpu_ms":51,"subrequests":20}},guard=guard)
  self.assertEqual(len(errors),1);self.assertIn("over the registry ceiling",errors[0])
 def test_limit_at_ceiling_passes_and_over_fails(self):
  errors,_=self.errors(config={**self.GOOD,"limits":{"cpu_ms":50,"subrequests":21}})
  self.assertEqual(len(errors),1);self.assertIn("limits.subrequests 21",errors[0])
 def test_non_integer_limit_fails(self):
  errors,_=self.errors(config={**self.GOOD,"limits":{"cpu_ms":"50","subrequests":20}})
  self.assertTrue(any("positive integer" in e for e in errors))
 def test_unregistered_config_fails(self):
  errors,_=self.errors(extra={**self.GOOD,"name":"other"})
  self.assertTrue(any("'other' is not in" in e for e in errors))
 def test_config_name_must_match_its_registry_entry(self):
  errors,_=self.errors(extra=self.GOOD)
  self.assertTrue(any("different config" in e for e in errors))
 def test_guard_and_status_are_required(self):
  errors,_=self.errors(guard="absent")
  self.assertTrue(any("no guard" in e for e in errors))
  errors,_=self.errors(guard={"status":"maybe","max_cpu_ms":50,"max_subrequests":20})
  self.assertTrue(any("guard status" in e for e in errors))
  errors,_=self.errors(guard={"status":"gated"})
  self.assertTrue(any("max_cpu_ms" in e for e in errors))
 def test_sampling_must_be_explicit(self):
  errors,_=self.errors(config={"name":"w","limits":self.GOOD["limits"],"observability":{"enabled":True}})
  self.assertTrue(any("head_sampling_rate" in e for e in errors))
 def test_jsonc_comments_and_trailing_commas(self):
  raw='{\n // a comment\n "name":"w", /* block */\n "limits":{"cpu_ms":50,"subrequests":20,},\n "observability":{"head_sampling_rate":1,},\n "note":"https://x//y,}",\n}\n'
  self.assertEqual(self.errors(raw=raw),([],[]))
  self.assertEqual(g.parse_jsonc(raw)["note"],"https://x//y,}")
 def test_unparseable_config_fails(self):
  errors,_=self.errors(raw="{nope")
  self.assertTrue(any("cannot parse" in e for e in errors))
if __name__=="__main__":unittest.main()
