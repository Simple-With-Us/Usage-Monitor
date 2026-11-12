import importlib.util,json,pathlib,os,secrets
root=pathlib.Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('hub_upgrade',root/'upgrade-reviewed-hub.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
digest='7d71eb6faf24e6992eddbd7a32911a2689a8216750fd4dc87a97b1f3cc3afea0'
path=root/'.um1651-hub-upgrade-0a92fcfa39f5b576f498dabc43963c89c47b3713.plan.json';p,_=m._plan(path,digest)
start=json.loads(m._read_private(m._receipt_path(path,digest,'start','receipt.json')))
if start.get('state') not in ('started','verified'):raise SystemExit('No confirmed start request')
base,bind=m._load_routing();api=m._Coolify(base,m._coolify_token(),p['service']['uuid'])
target=m._expected_target_compose(p);service,_=m._service_view(api,p,target)
if service.get('status') not in m.STARTED_STATUSES:raise SystemExit('Service not running')
ids=m._running_ids(m.IMAGE_NAME+':'+p['targetCommit'])
if len(ids)!=1 or ids[0]!=start['containerId']:raise SystemExit('Unexpected target container')
c=m._container(ids[0]);m._validate_container_identity(c,p,target=True,bind_host=bind)
if c['State'].get('Health',{}).get('Status')!='healthy':raise SystemExit('Target is not healthy yet')
meta=m._runtime_metadata(ids[0]);m._check_metadata_against_plan(meta,p,before_stop=False)
code="const fs=require('node:fs'),d='/data/state';console.log(JSON.stringify({intentPresent:fs.existsSync(d+'/sentry-request.json'),sentCounts:Object.fromEntries(fs.readdirSync(d).filter(n=>n.endsWith('.sent.json')).map(n=>[n.replace('.sent.json',''),JSON.parse(fs.readFileSync(d+'/'+n)).eventIds.length]))}));"
state=json.loads(m._docker(['exec',ids[0],'node','-e',code]))
if state['intentPresent'] or meta['pendingBytes']!=0:raise SystemExit('Sentry delivery is pending or held; inspect before closing')
ops=m.OPS_ROOT
old_service=json.loads(m._read_private(ops/'hub-service.json'))
if old_service!=p['service']:raise SystemExit('Private service tracking changed')
old_compose=m._read_private(ops/'hub-compose.json')
if m._sha(old_compose)!=p['preparedComposeSha256']:raise SystemExit('Private prepared compose changed')
for name in ['hub-service.json','hub-compose.json','hub-image.json']:
 old=m._read_private(ops/name);backup=ops/(name+'.before-um1651-0a92fcfa')
 fd=os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
 try:m._write_all(fd,old);os.fsync(fd)
 finally:os.close(fd)
def replace(name,value):
 dest=ops/name;tmp=ops/(name+'.'+secrets.token_hex(12)+'.tmp')
 m._write_exclusive(tmp,value);os.replace(tmp,dest)
 directory=os.open(ops,os.O_RDONLY|os.O_DIRECTORY)
 try:os.fsync(directory)
 finally:os.close(directory)
updated={**old_service,'source_commit':p['targetCommit'],'image_id':p['targetImageId']}
replace('hub-service.json',updated);replace('hub-compose.json',target)
replace('hub-image.json',{'tag':m.IMAGE_NAME+':'+p['targetCommit'],'image_id':p['targetImageId'],'source_commit':p['targetCommit']})
report={'phase':'independent-final-runtime-verification','planSha256':digest,'sourceCommit':p['targetCommit'],'imageId':p['targetImageId'],'containerId':ids[0],'healthy':True,'sameService':True,'sameDurableVolume':True,'configUnchanged':True,'configSha256':meta['configSha256'],'uid10001':True,'readonlyRootAndConfig':True,'privateHostListener':True,'noPublishedPorts':True,'sentryPendingBytes':meta['pendingBytes'],'intentPresent':state['intentPresent'],'sentCounts':state['sentCounts'],'privateTrackingUpdated':True}
m._write_exclusive(root/'.um1651-final-runtime-verification.json',report)
print(json.dumps(report))
