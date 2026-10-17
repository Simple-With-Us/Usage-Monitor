import importlib.util,json,unittest
from unittest.mock import patch
s=importlib.util.spec_from_file_location("deploy","scripts/deploy-mapped-worker.py");m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class Checks(unittest.TestCase):
 def test_partial_rollout_is_not_exact_receipt(self):
  with patch.object(m,"api",return_value={"deployments":[{"versions":[{"version_id":"a","percentage":50}]}]}):self.assertIsNone(m.deployed_tag("x"))
 def test_exact_tag(self):
  with patch.object(m,"api",side_effect=[{"deployments":[{"versions":[{"version_id":"a","percentage":100}]}]},{"annotations":{"workers/tag":"sha"}}]):self.assertEqual(m.deployed_tag("x"),"sha")
 def test_unconfigured_probe_blocks(self):
  with self.assertRaises(RuntimeError):m.probe({"name":"x"})
 def test_targets_are_explicit(self):
  self.assertNotIn("start-jays-services",m.TARGETS);self.assertNotIn("fleet-share-api",m.TARGETS)
if __name__=="__main__":unittest.main()
