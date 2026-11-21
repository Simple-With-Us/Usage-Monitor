import json,subprocess,pathlib
root=pathlib.Path('/tmp/um1646-ops')
s=json.loads((root/'hub-service.json').read_text())
def run(args):return subprocess.check_output(args,text=True,timeout=30)
ids=run(['docker','ps','--filter','ancestor=usage-monitor-telemetry-hub:'+s['source_commit'],'--format','{{.ID}}']).splitlines()
if len(ids)!=1:raise SystemExit('Expected exactly one current hub')
code="""const fs=require('node:fs'),crypto=require('node:crypto');const p='/run/secrets/telemetry-hub.json',b=fs.readFileSync(p),c=JSON.parse(b),st=fs.statSync(p),raw=c.TELEMETRY_HUB_SOURCES_JSON;const sources=JSON.parse(raw);const sha=x=>crypto.createHash('sha256').update(x).digest('hex');console.log(JSON.stringify({configSha256:sha(b),sourceMapRawSha256:sha(raw),sourceMembership:sources.map(s=>({id:s.id,platform:s.platform})),configUid:st.uid,configMode:st.mode&511,bindHost:process.env.TELEMETRY_HUB_BIND_HOST,sourceCount:sources.length}));"""
v=json.loads(run(['docker','exec',ids[0],'node','-e',code]));v['sourceCommit']=s['source_commit']
print(json.dumps(v))
