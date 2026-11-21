import importlib.util,json,pathlib
root=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('hub_upgrade',root/'upgrade-reviewed-hub.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
digest='7d71eb6faf24e6992eddbd7a32911a2689a8216750fd4dc87a97b1f3cc3afea0'
path=root/'.um1651-hub-upgrade-0a92fcfa39f5b576f498dabc43963c89c47b3713.plan.json'
p,_=m._plan(path,digest)
original=m._receipt_path(path,digest,'stop','receipt.json');r=json.loads(m._read_private(original))
if r.get('state')!='verification_failed' or r.get('reason')!='docker_command_failed':raise SystemExit('Unexpected original outcome')
base,bind=m._load_routing();api=m._Coolify(base,m._coolify_token(),p['service']['uuid'])
v,_=m._service_view(api,p)
if v.get('status') not in m.STOPPED_STATUSES:raise SystemExit('Service not stopped')
if m._running_ids(m.IMAGE_NAME+':'+p['service']['source_commit']) or m._running_ids(m.IMAGE_NAME+':'+p['targetCommit']):raise SystemExit('Unexpected running hub')
if m._docker(['ps','-a','--filter','ancestor='+m.IMAGE_NAME+':'+p['service']['source_commit'],'--format','{{.ID}}']).strip():raise SystemExit('Old container still exists; inspect separately')
m._port_is_free(bind);m._image_identity(p)
vol=m._docker_json(['volume','inspect',p['durableVolume']])
if len(vol)!=1 or vol[0].get('Name')!=p['durableVolume']:raise SystemExit('Volume changed')
code="const fs=require('node:fs'),c=require('node:crypto'),p='/run/secrets/telemetry-hub.json',s=fs.statSync(p);console.log(JSON.stringify({configSha256:c.createHash('sha256').update(fs.readFileSync(p)).digest('hex'),configUid:s.uid,configMode:s.mode&511}));"
data=json.loads(m._docker(['run','--rm','--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--mount','type=bind,src='+p['configMountSource']+',dst=/run/secrets/telemetry-hub.json,readonly','--entrypoint','node',m.IMAGE_NAME+':'+p['targetCommit'],'-e',code]))
if any(data[k]!=p['metadata'][k] for k in data):raise SystemExit('Configuration changed')
receipt={'phase':'stop','state':'verified','planSha256':digest,'originalReceiptSha256':m._sha(m._read_private(original)),'independentReadOnlyVerification':True,'serviceStopped':True,'oldContainerRemoved':True,'privatePortFree':True,'durableVolumePreserved':True,**data}
m._write_exclusive(m._receipt_path(path,digest,'stop','independent-readback.json'),receipt)
print(json.dumps(receipt))
