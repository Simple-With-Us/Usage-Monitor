import subprocess,json,urllib.request
code='from pathlib import Path; t=Path("/Users/jay/apps/MAC-LOCAL-PROCESSES.md").read_text(); s=t.index("## Usage Monitor Telemetry (UM-1646)"); e=t.find("\\n## ",s+4); print(t[s:e if e>=0 else None])'
r=subprocess.run(['ssh','mac','python3','-'],input=code,text=True,capture_output=True,timeout=30)
print(r.stdout if r.returncode==0 else json.dumps({'inventoryReadFailed':True,'exit':r.returncode}))
for path in ['/api/health','/api/ready?strict=1']:
 try:
  with urllib.request.urlopen(urllib.request.Request('https://usage.jays.services'+path,headers={'User-Agent':'Mozilla/5.0'}),timeout=15) as response:
   v=json.load(response);print(json.dumps({'route':path,'http':response.status,'ok':v.get('ok'),'status':v.get('status'),'revision':v.get('revision')}))
 except Exception as e: print(json.dumps({'route':path,'error':type(e).__name__}))
