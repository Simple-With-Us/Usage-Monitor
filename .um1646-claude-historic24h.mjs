import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

const root='/Users/jay/apps/usage-monitor-collectors';
const planFile='/tmp/um1646-sentry-historic-20261103/claude-historic-24h-plan-v3.json';
const receiptFile='/tmp/um1646-sentry-historic-20261103/claude-historic-24h-receipt-v3.json';
const fixedLower='2026-10-29T23:32:30.055Z';
const fixedUpper='2026-10-30T23:32:30.055Z';
const commit='ca19ad6ab8e98b5ac506d75d15b72dd0b9cd9015';
assert.match(commit,/^[a-f0-9]{40}$/);
const mode=process.env.UM_CLAUDE_CATCHUP_MODE;
assert.ok(['plan','apply'].includes(mode));
assert.equal(process.argv[1],undefined);
Object.defineProperty(process,'argv',{value:Object.freeze([...process.argv,'--dry-run']),writable:false,configurable:false});
assert.ok(process.argv.includes('--dry-run'));
assert.ok(!Object.keys(process.env).some(key=>/INGEST.*TOKEN|TOKEN.*INGEST/.test(key)&&process.env[key]));
// Block the installed token resolver's absolute fleet-secrets fallback too.
const originalExecFileSync=childProcess.execFileSync;
childProcess.execFileSync=(file,args,options)=>{
  if(!['ps','/bin/ps','/usr/bin/ps'].includes(file)||!Array.isArray(args)||args.length!==4||args[0]!=='-o'||args[1]!=='lstart='||args[2]!=='-p'||!/^\d+$/.test(String(args[3])))throw Error('Only read-only process birth lookup is allowed');
  return originalExecFileSync(file,args,options);
};
syncBuiltinESMExports();
assert.ok(!['1','true','yes','on'].includes((process.env.USAGE_MONITOR_EXCLUDE_BOTFLEET_CHILDREN||'').toLowerCase()));
const versionMatch=(await readFile(join(root,'VERSION'),'utf8')).match(/^sha=([a-f0-9]{7,40})$/m);
assert.ok(versionMatch&&commit.startsWith(versionMatch[1]));
const hash=value=>createHash('sha256').update(value).digest('hex');
const modules=['claude-usage-collector.mjs','lib/session-token-collectors.mjs','lib/collector-sentry-bridge.mjs','telemetry-hub/metadata-projection.mjs','telemetry-hub/allowlist.mjs','telemetry-hub/sentry-sender.mjs'];
const sourceHashes=await Promise.all(modules.map(async file=>[file,hash(await readFile(join(root,'scripts',file)))]));
const originalFetch=globalThis.fetch;
globalThis.fetch=()=>{throw Error('Plan/import phase prohibits network delivery');};
const {collectClaudeEvents}=await import(pathToFileURL(join(root,'scripts/claude-usage-collector.mjs')).href);
const {collectorSentryConfig,collectorSentryEvents,enqueueCollectorSentry,drainCollectorSentry}=await import(pathToFileURL(join(root,'scripts/lib/collector-sentry-bridge.mjs')).href);
const identity={producerId:'claude-code',producerInstanceId:process.env.USAGE_MACHINE_ID?.trim()||hostname()};
assert.ok(!process.env.CLAUDE_PRODUCER_ID||process.env.CLAUDE_PRODUCER_ID===identity.producerId);
const config=collectorSentryConfig(process.env,identity.producerId);
assert.equal(config?.destination,'hub');
const deliveryConfiguration={destination:config.destination,endpoint:config.endpoint,stateRoot:config.stateRoot};
const deliveryConfigDigest=hash(JSON.stringify(deliveryConfiguration));
let approved,planBytes;
if(mode==='apply'){
  planBytes=await readFile(planFile);
  assert.equal(hash(planBytes),process.env.UM_CLAUDE_CATCHUP_APPROVED_PLAN_SHA256);
  approved=JSON.parse(planBytes);
  assert.equal(approved.commit,commit);
  assert.equal(approved.sourceHashDigest,hash(JSON.stringify(sourceHashes)));
  assert.equal(approved.identityDigest,hash(JSON.stringify(identity)));
  assert.equal(approved.deliveryConfigDigest,deliveryConfigDigest);
}
const upper=mode==='plan'?new Date(fixedUpper):new Date(approved.upper);
const lower=mode==='plan'?new Date(fixedLower):new Date(approved.lower);
assert.equal(upper.getTime()-lower.getTime(),86400000);
const scanStatus={complete:true};
const sourceEvents=await collectClaudeEvents({since:lower,scanStatus});
assert.equal(scanStatus.complete,true);
assert.ok(sourceEvents.every(event=>Number.isFinite(Date.parse(event.occurredAt))));
const events=sourceEvents.filter(event=>Date.parse(event.occurredAt)>=lower.getTime()&&Date.parse(event.occurredAt)<=upper.getTime());
assert.ok(events.length<=60000);
assert.ok(events.every(event=>event.metricType==='usage'&&event.unit==='token'));
const projected=collectorSentryEvents(events,identity);
const calls=projected.filter(event=>event.name==='chat');
assert.ok(calls.length<=15000);
const measured=calls.filter(event=>Number.isFinite(event.durationMs)&&event.durationMs>=0).length;
const selectedDigest=hash(JSON.stringify([...projected].sort((a,b)=>a.eventId.localeCompare(b.eventId))));
const summary={commit,windowHours:24,components:events.length,callMarkers:calls.length,observations:projected.length-calls.length,measuredDurations:measured,measuredCallSpans:calls.filter(event=>event.kind==='span').length,unmeasuredCallLogs:calls.filter(event=>event.kind==='log'&&!Number.isFinite(event.durationMs)).length,excludedAfterUpper:sourceEvents.length-events.length};
const plan={...summary,lower:lower.toISOString(),upper:upper.toISOString(),selectedDigest,sourceHashDigest:hash(JSON.stringify(sourceHashes)),identityDigest:hash(JSON.stringify(identity)),deliveryConfiguration,deliveryConfigDigest,maxComponents:60000,maxCallMarkers:15000,maxDrainInvocations:16,globalDrainBudgetMs:55000,perInvocationRequestLimit:32,perInvocationBudgetMs:5000};
if(mode==='plan'){
  const bytes=Buffer.from(JSON.stringify(plan,null,2)+'\n');
  await writeFile(planFile,bytes,{flag:'wx',mode:0o600});
  console.log(JSON.stringify({mode,...summary,approvedPlanSha256:hash(bytes),durableOutboxTouched:false,networkRequests:0,umPosts:0,checkpointWrites:0}));
}else{
  assert.equal(selectedDigest,approved.selectedDigest);
  assert.equal(events.length,approved.components);
  assert.equal(calls.length,approved.callMarkers);
  const allowed=new Set(['/v1/traces','/v1/logs'].map(signal=>config.endpoint+signal));
  globalThis.fetch=(url,options)=>{
    if(!allowed.has(String(url))||options?.method!=='POST')throw Error('Only the reviewed hub delivery target is allowed');
    return originalFetch(url,options);
  };
  // The installed converter projects metadata before its durable SQLite write.
  const outbox=await enqueueCollectorSentry(events,identity,config);
  const deadline=performance.now()+55000;
  const results=[];
  for(let invocation=1;invocation<=16&&performance.now()+5000<=deadline;invocation++){
    const result=await drainCollectorSentry(outbox,config,{requestLimit:32,budgetMs:5000});
    results.push({invocation,...result});
    if(!result.pending||(!result.delivered&&!result.quarantined))break;
  }
  const receipt={mode,...summary,planSha256:hash(planBytes),umPosts:0,checkpointWrites:0,sourceWrites:0,results};
  await writeFile(receiptFile,JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify(receipt));
}
