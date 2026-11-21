import pathlib,json,os,hashlib
root=pathlib.Path(__file__).resolve().parent
dest=pathlib.Path('/home/jay/.codex/outputs/um-1646')
names=[root/'.um1651-final-runtime-verification.json',root/'.um1646-child-pair-apply-ae3a6cbb3461248daad470f024b766a4b11ab189cce28af3894fc96616bb34b7.json',pathlib.Path('/tmp/um1646-child-sentry-apply-receipt-20261103.json'),pathlib.Path('/tmp/um1646-child-final-hub-readback-20261103.json'),pathlib.Path('/tmp/um1646-child-sentry-stored-baseline-20261103.json'),pathlib.Path('/tmp/um1646-child-metadata-two-receipt-20261103.json'),pathlib.Path('/tmp/um1646-child-metadata-two-receiver-read-20261103.json')]
for source in names:
 data=source.read_bytes();json.loads(data)
 target=dest/source.name.lstrip('.')
 if target.exists():
  if target.read_bytes()!=data:raise SystemExit('Preserved receipt differs')
 else:
  fd=os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600)
  with os.fdopen(fd,'wb')as handle:handle.write(data);handle.flush();os.fsync(handle.fileno())
 print(json.dumps({'receipt':str(target),'sha256':hashlib.sha256(data).hexdigest()}))
