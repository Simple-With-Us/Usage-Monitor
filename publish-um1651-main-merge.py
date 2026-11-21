"""Publish the reviewed merge tree with both real parents through CODEX Relay."""
import json
import os
from pathlib import Path
import subprocess

root = Path('/mnt/fleet-extra/apps/lanes/Usage-Monitor/codex-um1646-sentry-partial-ack')
local_head = '276ba0e955b255a445282a44072b22af0e50c6d6'
remote_head = 'd5441d9b500d553f096d8beac9c9340e4aaf38b7'
main_head = '5c218189851cbc44dfc7271e3879cda8b481d446'
expected_tree = 'b0effe5d5afb89f68a7f382a1e92bdccf85b95e1'
paths = ['package.json', 'scripts/telemetry-hub/journal.mjs', 'scripts/telemetry-hub/sentry-sender.mjs', 'scripts/sentry-partial-ack.node-test.mjs', 'docs/rollouts/2026-11-03-sentry-partial-acks.md']
def git(*args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()
if git('rev-parse', 'HEAD') != local_head or git('rev-parse', 'HEAD^2') != main_head or git('rev-parse', 'HEAD^{tree}') != expected_tree or git('status', '--porcelain'):
    raise SystemExit('Reviewed merge source changed')
if set(git('diff', '--name-only', main_head, local_head).splitlines()) != set(paths):
    raise SystemExit('Merge includes an unexpected changed file')
receipt_path = Path('.um1651-main-merge-publish-receipt.json')
fd = os.open(receipt_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
receipt = {'phase':'prepared','localHead':local_head,'remoteHead':remote_head,'mainHead':main_head,'expectedTree':expected_tree}
def save():
    os.lseek(fd,0,os.SEEK_SET); os.ftruncate(fd,0)
    os.write(fd,(json.dumps(receipt)+'\n').encode()); os.fsync(fd)
save()
p = subprocess.Popen(['/home/jay/.local/libexec/codex-simple-tools'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def rpc(method, params, identifier):
    p.stdin.write(json.dumps({'jsonrpc':'2.0','id':identifier,'method':method,'params':params})+'\n');p.stdin.flush()
    for line in p.stdout:
        try: result=json.loads(line)
        except ValueError: continue
        if result.get('id')==identifier:return result
    raise RuntimeError('Assigned Relay closed; inspect before retry')
def call(name, args, identifier):
    reply=rpc('tools/call',{'name':name,'arguments':{'identity':'CODEX','repo':'Simple-With-Us/Usage-Monitor',**args}},identifier)
    if 'error' in reply:raise RuntimeError('Relay RPC refused')
    result=reply.get('result',{}); data=result.get('structuredContent')
    if data is None:
        for block in result.get('content',[]):
            if block.get('type')=='text':
                try:data=json.loads(block['text']);break
                except ValueError:continue
    if not isinstance(data,dict) or result.get('isError') or data.get('code'):
        raise RuntimeError('Relay operation refused; inspect receipt and destination')
    return data
try:
    if 'error' in rpc('initialize',{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'codex-um1651-merge-publication','version':'1'}},1):raise RuntimeError('Assigned connection refused')
    p.stdin.write(json.dumps({'jsonrpc':'2.0','method':'notifications/initialized'})+'\n');p.stdin.flush()
    result=call('gr_wf_git_tree_create',{'base_tree':git('rev-parse',main_head+'^{tree}'),'files':[{'path':path,'mode':'100644','text':(root/path).read_text()} for path in paths]},2)
    tree=(result.get('tree') or result).get('sha')
    receipt.update(phase='treeCreated',tree=tree);save()
    if tree!=expected_tree:raise RuntimeError('Published merge tree differs')
    result=call('gr_wf_git_commit_create',{'tree_sha':tree,'parents':[remote_head,main_head],'message':'Merge Main And Preserve Both Collector Runtime Gates'},3)
    commit=(result.get('commit') or result).get('sha')
    if not isinstance(commit,str) or len(commit)!=40:raise RuntimeError('Created merge commit identity unavailable')
    receipt.update(phase='commitCreated',commit=commit);save()
    call('gr_wf_branch_update',{'branch':'codex/um1646-sentry-partial-ack','expected_sha':remote_head,'sha':commit},4)
    receipt.update(phase='branchUpdated');save()
    print(json.dumps({'phase':receipt['phase'],'commit':commit,'tree':tree,'parents':[remote_head,main_head]}))
finally:
    os.close(fd);p.terminate()
    try:p.wait(timeout=5)
    except subprocess.TimeoutExpired:p.kill();p.wait(timeout=5)
