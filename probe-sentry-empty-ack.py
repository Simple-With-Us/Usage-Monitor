"""Inspect the ACK shape for zero-event envelopes using existing hub custody."""
import json
from pathlib import Path
import subprocess

service = json.loads(Path('/tmp/um1646-ops/hub-service.json').read_text())
image = 'usage-monitor-telemetry-hub:' + service['source_commit']
p = subprocess.run(['docker', 'ps', '--filter', 'ancestor=' + image, '--format', '{{.ID}}'], capture_output=True, text=True, check=True)
ids = p.stdout.splitlines()
if len(ids) != 1:
    raise SystemExit('Expected one known hub')
script = r"""
const fs=require('node:fs'),zlib=require('node:zlib');
const cfg=JSON.parse(fs.readFileSync('/run/secrets/telemetry-hub.json'));
const endpoint=cfg.SENTRY_OTLP_ENDPOINT?.replace(/\/+$/,'');
if(!endpoint||!cfg.SENTRY_PUBLIC_KEY)throw Error('Existing custody unavailable');
const outputs=[];
for(const signal of ['logs','traces']){
 const body=zlib.gzipSync(Buffer.from(JSON.stringify(signal==='logs'?{resourceLogs:[]}:{resourceSpans:[]})));
 try{
  const response=await fetch(endpoint+'/v1/'+signal,{method:'POST',headers:{'content-type':'application/json','content-encoding':'gzip','x-sentry-auth':'sentry sentry_key='+cfg.SENTRY_PUBLIC_KEY},body,redirect:'error',signal:AbortSignal.timeout(10000)});
  const reader=response.body?.getReader();let length=0;const chunks=[];
  if(reader){for(;;){const next=await reader.read();if(next.done)break;length+=next.value.byteLength;if(length>65536){await reader.cancel();throw Error('ACK size bound');}chunks.push(next.value);}}
  const text=Buffer.concat(chunks).toString('utf8');let parsed;
  try{parsed=JSON.parse(text);}catch{}
  const obj=parsed&&typeof parsed==='object'&&!Array.isArray(parsed);
  outputs.push({signal,submittedEvents:0,status:response.status,contentType:response.headers.get('content-type'),responseBytes:length,empty:text.trim()==='',jsonObject:Boolean(obj),emptyJsonObject:obj&&Object.keys(parsed).length===0,partialSuccessPresent:Boolean(obj&&(parsed.partialSuccess||parsed.partial_success))});
 }catch(error){outputs.push({signal,submittedEvents:0,errorClass:error.name});}
}
console.log(JSON.stringify({existingCustody:true,envelopesContainNoEvents:true,outputs}));
"""
p = subprocess.run(['docker', 'exec', '-i', ids[0], 'node', '--input-type=module', '-e', script.replace("const fs=require('node:fs'),zlib=require('node:zlib');", "import fs from 'node:fs';import zlib from 'node:zlib';")], capture_output=True, text=True, timeout=30)
if p.returncode:
    raise SystemExit('Empty-envelope probe failed; no raw stderr printed')
data = json.loads(p.stdout)
path = Path('.um1651-empty-sentry-ack-receipt.json')
import os
fd = os.open(path, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
with os.fdopen(fd, 'w') as handle:
    json.dump(data, handle)
print(json.dumps(data))
