import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const source=readFileSync(process.argv[2] || '/downloads/fleet-secrets-patches/Usage-Monitor/scripts/telemetry-hub/um-sender.mjs','utf8');
const direct=source.slice(source.indexOf('import { execFile }'),source.indexOf('import { NULL_LOGGER }'));
const resolver=source.slice(source.indexOf('export function createTokenResolver'),source.indexOf('\n/**\n * Read the overlap policy'));
const {createTokenResolver}=process.env.UM_FULL_MODULE ? await import(process.env.UM_FULL_MODULE) : await import('data:text/javascript;base64,'+Buffer.from(direct+'\nconst TOKEN_MEMO_MS=60000;\n'+resolver).toString('base64'));
const dir=mkdtempSync(join(tmpdir(),'sender-scoped-'));const stub=join(dir,'fake.sh'),log=join(dir,'calls');
writeFileSync(stub,`#!/bin/sh
printf 'called\\n' >> '${log}'
[ -z "$TOKEN$INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN$INFISICAL_API_URL$INFISICAL_CLIENT_ID$INFISICAL_CLIENT_SECRET$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" ] || exit 41
[ "$INFISICAL_DOMAIN" = https://app.infisical.com ] || exit 42
case "$MODE" in
value) printf synthetic-token;;
folder) case "$*" in *--path=/global-api-keys*) printf synthetic-folder-token;;esac;;
fail) echo synthetic-secret-marker >&2;exit 43;;
mixed) case "$*" in *--path=/global-api-keys*) echo synthetic-secret-marker >&2;exit 43;;*) exit 0;;esac;;
slow) sleep 1;printf synthetic-delayed-token;;
esac
`,{mode:0o700});
let n=0;const check=()=>n++;
const base=()=>({INFISICAL_TOKEN:'synthetic-binding',INFISICAL_FLEET_OPS_PROJECT_ID:'synthetic-project',INFISICAL_BIN:stub,MODE:'value',TOKEN:'bad',INFISICAL_UNIVERSAL_AUTH_ACCESS_TOKEN:'bad',INFISICAL_API_URL:'bad',INFISICAL_CLIENT_ID:'bad',INFISICAL_CLIENT_SECRET:'bad',INFISICAL_UNIVERSAL_AUTH_CLIENT_ID:'bad',INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET:'bad'});
try {
let env=base(),t=100000,r=createTokenResolver({env,now:()=>t});assert.equal(await r(),'synthetic-token');check();
env.MODE='fail';assert.equal(await r(),'synthetic-token');check();t+=60001;assert.equal(await r(),'synthetic-token');check();
env.MODE='folder';assert.equal(await r(),'synthetic-folder-token');check();
env=base();env.MODE='fail';r=createTokenResolver({env});await assert.rejects(r(),e=>!e.message.includes('synthetic-secret-marker')&&!e.cause&&/status\(43\)/.test(e.message));check();
env=base();env.MODE='empty';t=100000;r=createTokenResolver({env,now:()=>t});assert.equal(await r(),undefined);env.MODE='value';assert.equal(await r(),undefined);check();t+=60001;assert.equal(await r(),'synthetic-token');check();
env={USAGE_INGEST_TOKEN:' env-first '};assert.equal(await createTokenResolver({env})(),'env-first');check();
assert.equal(await createTokenResolver({env:{}})(),undefined);check();
env=base();env.MODE='mixed';assert.equal(await createTokenResolver({env})(),undefined);check();
env=base();env.MODE='slow';let tick=false;setTimeout(()=>tick=true,10);assert.equal(await createTokenResolver({env})(),'synthetic-delayed-token');assert.equal(tick,true);check();
let calls=0;r=createTokenResolver({env:{},now:()=>100000,getSecret:async(name,opt)=>{assert.equal(name,'USAGE_INGEST_TOKEN');assert.equal(opt.strict,true);calls++;return ' injected ';}});assert.equal(await r(),'injected');assert.equal(calls,1);check();
console.log(`${n}/${n} sender direct/read/memo/injection checks passed`);
}finally{rmSync(dir,{recursive:true,force:true});}
