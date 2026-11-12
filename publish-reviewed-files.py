"""Publish four reviewed files using the assigned own-seat Relay connection."""
import base64
import json
from pathlib import Path
import subprocess

paths = ["scripts/lib/collector-sentry-bridge.mjs", "scripts/collector-sentry-bridge.node-test.mjs"]
arguments = {"identity":"CODEX", "repo":"Simple-With-Us/Usage-Monitor", "branch":"codex/um1646-unmeasured-call-logs", "expected_head_sha":"fc7a034f050a68ea5c75c105f1ce9de80b324b6b", "message":"Keep Invalid Call Timing Within The Date Domain", "files":[{"path":path, "content_b64":base64.b64encode(Path(path).read_bytes()).decode()} for path in paths]}
process = subprocess.Popen(["/home/jay/.local/libexec/codex-simple-tools"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def send(value):
    process.stdin.write(json.dumps(value) + "\n")
    process.stdin.flush()
def receive(identifier):
    for line in process.stdout:
        try: value = json.loads(line)
        except ValueError: continue
        if value.get("id") == identifier: return value
    raise RuntimeError("Assigned wrapper closed before response; inspect destination before retry")
try:
    send({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"protocolVersion":"2024-11-05", "capabilities":{}, "clientInfo":{"name":"codex-um1646-publication", "version":"1"}}})
    if "error" in receive(1): raise RuntimeError("Assigned wrapper initialization refused")
    send({"jsonrpc":"2.0", "method":"notifications/initialized"})
    send({"jsonrpc":"2.0", "id":2, "method":"tools/call", "params":{"name":"gr_wf_files_put", "arguments":arguments}})
    result = receive(2)
    Path(".um1646-relay-publication-receipt.json").write_text(json.dumps(result))
    # The action returns commit metadata, never credentials or source configuration.
    for content in result.get("result", {}).get("content", []):
        if content.get("type") == "text": print(content["text"])
    if "error" in result: print(json.dumps({"rpcError":True}))
finally:
    process.terminate()
    try: process.wait(timeout=5)
    except subprocess.TimeoutExpired: process.kill()
