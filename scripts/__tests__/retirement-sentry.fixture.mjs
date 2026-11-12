import assert from 'node:assert/strict';
import {configureCollectorSentryToken as configure} from '../lib/run-session-token-collector.mjs';
const base=()=>({COLLECTOR_SENTRY_ENABLED:'1',COLLECTOR_TELEMETRY_HUB_ENDPOINT:'https://synthetic.invalid'});
let n=0;
assert.equal(configure(['K'],{env:{},fleetSecretsGet:()=>{throw Error('must not run')}}),false);n++;
assert.equal(configure(['K'],{env:{COLLECTOR_SENTRY_ENABLED:'1'},fleetSecretsGet:()=>{throw Error('must not run')}}),false);n++;
for(const key of ['COLLECTOR_TELEMETRY_HUB_TOKEN','COLLECTOR_TELEMETRY_HUB_TOKENS_JSON']){let env={...base(),[key]:'existing'};assert.equal(configure(['K'],{env,fleetSecretsGet:()=>{throw Error('must not run')}}),true);n++;}
let env={...base(),K:' env-token '};assert.equal(configure(['K'],{env}),true);assert.equal(env.COLLECTOR_TELEMETRY_HUB_TOKEN,'env-token');n++;
env=base();assert.equal(configure(['K'],{env,fleetSecretsGet:()=> ' injected '}),true);assert.equal(env.COLLECTOR_TELEMETRY_HUB_TOKEN,'injected');n++;
env=base();assert.equal(configure(['K'],{env}),false);n++;
env=base();assert.throws(()=>configure(['K'],{env,fleetSecretsGet:()=>{throw Error('synthetic-fail')}}),/synthetic-fail/);assert.equal(env.COLLECTOR_TELEMETRY_HUB_TOKEN,undefined);n++;
env={...base(),SECOND:'later-env'};assert.equal(configure(['FIRST','SECOND'],{env,fleetSecretsGet:()=>{throw Error('synthetic-fail')}}),true);assert.equal(env.COLLECTOR_TELEMETRY_HUB_TOKEN,'later-env');n++;
console.log(`${n}/${n} Sentry configuration checks passed`);
