"""Read only the named historical replay receipt; expose keys and numeric ACKs."""
import json
import subprocess

remote = r'''
import pathlib,json
p=pathlib.Path.home()/'apps/usage-monitor-collectors/.um-1646-historical-replay-receipt.json'
v=json.loads(p.read_text()) if p.is_file() else {}
allowed={'received','persisted','rejected','duplicates','pruned','attempted','events','batches','http','retryCount','recovered503','recovered502','sentryEnabled','checkpointAdvanced'}
def counters(value,depth=0):
 if not isinstance(value,dict) or depth>3:return {}
 out={}
 for key,item in value.items():
  if key in allowed and isinstance(item,(int,bool)):out[key]=item
  elif isinstance(item,dict):
   nested=counters(item,depth+1)
   if nested:out[key]=nested
 return out
print(json.dumps({'present':p.is_file(),'keys':sorted(v) if isinstance(v,dict) else [],'counters':counters(v)}))
'''
p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "mac", "python3", "-"], input=remote.encode(), capture_output=True, timeout=30)
if p.returncode: raise SystemExit("Named Mac receipt read failed; no raw output printed")
print(json.dumps(json.loads(p.stdout)))
