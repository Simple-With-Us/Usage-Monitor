import json,pathlib,subprocess,os
p=json.loads(pathlib.Path('/tmp/um1646-child-sentry-storage-read-plan-20261103.json').read_text())
image='usage-monitor-telemetry-hub:0a92fcfa39f5b576f498dabc43963c89c47b3713'
def run(a):return subprocess.check_output(a,text=True,timeout=30)
ids=run(['docker','ps','--filter','ancestor='+image,'--format','{{.ID}}']).splitlines()
if len(ids)!=1:raise SystemExit('Expected one exact merged hub')
code="""const fs=require('node:fs'),id=process.argv[1],d='/data/state';const sent=JSON.parse(fs.readFileSync(d+'/sentry.sent.json')).eventIds;const base=JSON.parse(fs.readFileSync(d+'/journal.base.json')).base,offset=JSON.parse(fs.readFileSync(d+'/sentry.offset.json')).offset,bytes=fs.statSync('/data/journal.jsonl').size;const rows=fs.readFileSync('/data/journal.jsonl','utf8').split('\\n').filter(Boolean).map(JSON.parse).filter(e=>e.eventId===id);console.log(JSON.stringify({exactHubEventJournalRows:rows.length,exactHubEventSent:sent.includes(id),sentryPendingBytes:base+bytes-offset,intentPresent:fs.existsSync(d+'/sentry-request.json')}));"""
v=json.loads(run(['docker','exec',ids[0],'node','-e',code,p['hubEventId']]))
c=json.loads(run(['docker','inspect',ids[0]]))[0]
v.update(sourceCommit=c['Config']['Labels']['org.opencontainers.image.revision'],healthy=c['State']['Health']['Status']=='healthy',exactHubEventIdDigest=__import__('hashlib').sha256(p['hubEventId'].encode()).hexdigest())
if not v['healthy'] or not v['exactHubEventSent'] or v['sentryPendingBytes']!=0 or v['intentPresent']:raise SystemExit('Exact child delivery not fully confirmed in hub state')
out=pathlib.Path('/tmp/um1646-child-final-hub-readback-20261103.json');fd=os.open(out,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
with os.fdopen(fd,'w') as f:json.dump(v,f)
print(json.dumps(v))
