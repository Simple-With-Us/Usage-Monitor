import importlib.util,io,json,os,re,unittest
from unittest.mock import patch
s=importlib.util.spec_from_file_location("deploy","scripts/deploy-mapped-worker.py");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
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
   self.assertTrue(m.TARGETS[name].get("health"),name+" has no approved functional probe")
  self.assertNotIn("usage-monitor-receipt-lifecycle-auditor",workers)
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
 def test_superseded_main_skips_before_any_mutation(self):
  with patch.object(m.sys,"argv",["deploy","expenses-jays-services"]),\
   patch.object(m.subprocess,"check_output",return_value="old\n"),\
   patch.object(m,"current_main",return_value="new"),\
   patch.object(m,"deployed_tag") as deployed_tag,\
   patch.object(m,"probe") as probe,\
   patch.object(m.subprocess,"run") as run:
   m.main()
  deployed_tag.assert_not_called();probe.assert_not_called();run.assert_not_called()
if __name__=="__main__":unittest.main()
