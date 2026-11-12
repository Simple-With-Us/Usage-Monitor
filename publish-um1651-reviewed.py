"""Publish the five reviewed source files through the assigned CODEX Relay."""
import base64
import json
from pathlib import Path
import subprocess

source = Path('/mnt/fleet-extra/apps/lanes/Usage-Monitor/codex-um1646-sentry-partial-ack')
expected_commit = '3b7884b096656b9a0e7a274548408a47c97d382d'
if subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() != expected_commit:
    raise SystemExit('Reviewed source commit changed')
if subprocess.check_output(['git', '-C', str(source), 'status', '--porcelain'], text=True).strip():
    raise SystemExit('Reviewed source worktree is not clean')
paths = ['scripts/telemetry-hub/sentry-sender.mjs', 'scripts/telemetry-hub/journal.mjs', 'scripts/sentry-partial-ack.node-test.mjs', 'docs/rollouts/2026-11-03-sentry-partial-acks.md']
args = {'identity': 'CODEX', 'repo': 'Simple-With-Us/Usage-Monitor', 'branch': 'codex/um1646-sentry-partial-ack', 'expected_head_sha': 'f9c75027e85dab5f9983cbe119128acaad2baf13', 'message': 'Document Reconciled Sentry Hold Recovery And Preserve Its Latch', 'files': [{'path': path, 'content_b64': base64.b64encode((source / path).read_bytes()).decode()} for path in paths]}
p = subprocess.Popen(['/home/jay/.local/libexec/codex-simple-tools'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def send(value):
    p.stdin.write(json.dumps(value) + '\n')
    p.stdin.flush()
def receive(identifier):
    for line in p.stdout:
        try: value = json.loads(line)
        except ValueError: continue
        if value.get('id') == identifier: return value
    raise RuntimeError('Assigned wrapper closed; inspect destination before retry')
try:
    send({'jsonrpc':'2.0','id':1,'method':'initialize','params':{'protocolVersion':'2024-11-05','capabilities':{},'clientInfo':{'name':'codex-um1651-publication','version':'1'}}})
    if 'error' in receive(1): raise RuntimeError('Assigned connection initialization refused')
    send({'jsonrpc':'2.0','method':'notifications/initialized'})
    send({'jsonrpc':'2.0','id':2,'method':'tools/call','params':{'name':'gr_wf_files_put','arguments':args}})
    result = receive(2)
    path = Path('.um1651-relay-publication-' + expected_commit[:12] + '.json')
    import os
    fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as handle: json.dump(result, handle)
    for block in result.get('result', {}).get('content', []):
        if block.get('type') == 'text': print(block['text'])
    if 'error' in result: raise SystemExit('Publication outcome requires readback')
finally:
    p.terminate()
    try: p.wait(timeout=5)
    except subprocess.TimeoutExpired: p.kill(); p.wait(timeout=5)
