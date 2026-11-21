import json,pathlib,re,subprocess
inventory=pathlib.Path('/mnt/fleet-extra/Code/Fleet-OPS/ATTACK-MAP.md').read_text()
row=next(x for x in inventory.splitlines()if x.startswith('| Usage Monitor |'))
name=re.findall(r'`([^`]+)`',row)[0]
p=subprocess.run(['docker','inspect',name],capture_output=True,text=True,check=True,timeout=20)
v=json.loads(p.stdout)[0]
env=dict(s.split('=',1)for s in v['Config'].get('Env',[])if'='in s)
raw=env.get('BOTFLEET_CHILD_COVERAGE_DROP')
print(json.dumps({'flag':'BOTFLEET_CHILD_COVERAGE_DROP','present':raw is not None,'enabled':raw in('1','true'),'unknownValue':raw is not None and raw not in('0','false','1','true',''),'containerRunning':v['State']['Running']}))
