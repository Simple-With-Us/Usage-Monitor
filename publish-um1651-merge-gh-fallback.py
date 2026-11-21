"""Use the owner's thread-only fallback after the Relay merge-tree refusal."""
import json
import os
from pathlib import Path
import subprocess

source=Path('/mnt/fleet-extra/apps/lanes/Usage-Monitor/codex-um1646-sentry-partial-ack')
old='d5441d9b500d553f096d8beac9c9340e4aaf38b7'
main='5c218189851cbc44dfc7271e3879cda8b481d446'
local='276ba0e955b255a445282a44072b22af0e50c6d6'
tree='b0effe5d5afb89f68a7f382a1e92bdccf85b95e1'
repo='Simple-With-Us/Usage-Monitor'
branch='codex/um1646-sentry-partial-ack'
paths=['package.json','scripts/telemetry-hub/journal.mjs','scripts/telemetry-hub/sentry-sender.mjs','scripts/sentry-partial-ack.node-test.mjs','docs/rollouts/2026-11-03-sentry-partial-acks.md']
def git(*args):return subprocess.check_output(['git','-C',str(source),*args],text=True).strip()
if git('rev-parse','HEAD')!=local or git('rev-parse','HEAD^{tree}')!=tree or git('status','--porcelain'):
    raise SystemExit('Reviewed merge source changed')
def private(path,value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
    with os.fdopen(fd,'w') as handle:json.dump(value,handle);handle.flush();os.fsync(handle.fileno())
def api(path,method='GET',body_path=None):
    args=['gh','api','repos/'+repo+'/'+path,'--method',method]
    if body_path:args+=['--input',str(body_path)]
    p=subprocess.run(args,capture_output=True,text=True)
    if p.returncode:raise RuntimeError('GitHub operation failed; inspect destination before retry')
    return json.loads(p.stdout)
if api('git/ref/heads/'+branch)['object']['sha']!=old:
    raise SystemExit('Remote branch changed')
receipt={'phase':'prepared','expectedOldHead':old,'mainParent':main,'localHead':local,'expectedTree':tree}
receipt_path=Path('.um1651-gh-merge-receipt.json')
private(receipt_path,receipt)
def save():
    with receipt_path.open('w') as handle:json.dump(receipt,handle);handle.flush();os.fsync(handle.fileno())
body=Path('.um1651-gh-tree-body.json')
private(body,{'base_tree':git('rev-parse',main+'^{tree}'),'tree':[{'path':p,'mode':'100644','type':'blob','content':(source/p).read_text()} for p in paths]})
actual=api('git/trees','POST',body)['sha']
receipt.update(phase='treeCreated',tree=actual);save()
if actual!=tree:raise SystemExit('Published tree differs from reviewed tree')
body=Path('.um1651-gh-commit-body.json')
identity={'name':'Codex','email':'344783151+swu-codex[bot]@users.noreply.github.com'}
private(body,{'message':'Merge Main And Preserve Both Collector Runtime Gates','tree':tree,'parents':[old,main],'author':identity,'committer':identity})
commit=api('git/commits','POST',body)['sha']
receipt.update(phase='commitCreated',commit=commit);save()
body=Path('.um1651-gh-ref-body.json');private(body,{'sha':commit,'force':False})
updated=api('git/refs/heads/'+branch,'PATCH',body)
if updated['object']['sha']!=commit:raise SystemExit('Branch outcome requires readback')
receipt.update(phase='branchUpdated');save()
print(json.dumps({'phase':'branchUpdated','commit':commit,'tree':tree,'force':False,'threadSpecificOwnerException':True}))
