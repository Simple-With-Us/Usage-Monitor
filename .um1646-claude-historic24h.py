import json, os, pathlib, plistlib, subprocess, sys
mode=sys.argv[1] if len(sys.argv)>1 else None
if mode not in ('plan','apply'):raise SystemExit('Use plan or apply')
path=pathlib.Path.home()/'Library/LaunchAgents/com.jays.claude-usage-collector.plist'
with path.open('rb') as handle:job=plistlib.load(handle)
env={**os.environ,**job.get('EnvironmentVariables',{})}
for key in list(env):
    if ('INGEST' in key and 'TOKEN' in key):del env[key]
tokens=json.loads(env['COLLECTOR_TELEMETRY_HUB_TOKENS_JSON'])
env['COLLECTOR_TELEMETRY_HUB_TOKENS_JSON']=json.dumps({'claude-code':tokens['claude-code']},separators=(',',':'))
env['UM_CLAUDE_CATCHUP_MODE']=mode
if mode=='apply' and len(env.get('UM_CLAUDE_CATCHUP_APPROVED_PLAN_SHA256',''))!=64:raise SystemExit('Exact approved plan digest required')
code=pathlib.Path('/tmp/um1646-sentry-historic-20261103/claude-historic-24h.mjs').read_text()
result=subprocess.run([job['ProgramArguments'][0],'--input-type=module'],input=code,text=True,capture_output=True,env=env,timeout=180)
if result.returncode:raise SystemExit('Catch-up guard failed; no source or configuration values printed')
rows=[json.loads(line) for line in result.stdout.splitlines() if line.startswith('{')]
if len(rows)!=1:raise SystemExit('Unexpected catch-up output; no content printed')
print(json.dumps(rows[0]))
