import { test } from 'vitest';
import assert from 'node:assert/strict';

test('Next production server loads config with a runtime token and no source SHA',async()=>{
 const {spawnSync}=await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const result=spawnSync(process.execPath,['-e',`
   require('next/dist/server/config').default(
     require('next/constants').PHASE_PRODUCTION_SERVER, process.cwd()
   ).then(config => {
     if (config.poweredByHeader !== false) process.exitCode = 1;
   }).catch(() => { process.exitCode = 1; });
 `],{
   cwd:fileURLToPath(new URL('../../../',import.meta.url)),
   env:{NODE_ENV:'production',SENTRY_AUTH_TOKEN:'test-only',NEXT_TELEMETRY_DISABLED:'1'},
   encoding:'utf8',timeout:30000,
 });
 assert.equal(result.status,0,'Next production server config must load without build-only release metadata');
});
test('Next runtime loader preserves Sentry client tracing without upload credentials',async()=>{
 const {spawnSync}=await import('node:child_process');
 const {fileURLToPath}=await import('node:url');
 const result=spawnSync(process.execPath,['-e',`
   const assert = require('node:assert/strict');
   const sentry = require('@sentry/nextjs/config');
   const original = sentry.withSentryConfig;
   let observed = false;
   sentry.withSentryConfig = (config, options) => {
     observed = true;
     assert.equal(options.authToken, undefined);
     assert.equal(options.errorHandler, undefined);
     assert.equal(options.sourcemaps.disable, true);
     return original(config, options);
   };
   require('next/dist/server/config').default(
     require('next/constants').PHASE_PRODUCTION_SERVER, process.cwd()
   ).then(config => {
     assert.equal(observed, true);
     assert.equal(config.poweredByHeader, false);
     assert.ok(config.experimental.clientTraceMetadata.includes('sentry-trace'));
     assert.ok(config.experimental.clientTraceMetadata.includes('baggage'));
   }).catch(() => { process.exitCode = 1; });
 `],{
   cwd:fileURLToPath(new URL('../../../',import.meta.url)),
   env:{NODE_ENV:'production',SENTRY_AUTH_TOKEN:'test-only',SENTRY_DSN:'test-only',NEXT_TELEMETRY_DISABLED:'1'},
   encoding:'utf8',timeout:30000,
 });
 assert.equal(result.status,0,'Runtime must preserve real Sentry tracing options without build-only credentials');
});
