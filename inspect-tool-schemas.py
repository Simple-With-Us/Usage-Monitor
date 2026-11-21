"""Inspect only named tool schemas through the assigned CODEX wrapper."""
import json
import subprocess
import sys

wanted = set(sys.argv[1:])
process = subprocess.Popen(["/home/jay/.local/libexec/codex-simple-tools"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
def send(value):
    process.stdin.write(json.dumps(value) + "\n")
    process.stdin.flush()
def receive(identifier):
    for line in process.stdout:
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if value.get("id") == identifier:
            return value
    raise RuntimeError("Assigned wrapper closed before schema response")
try:
    send({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"protocolVersion":"2024-11-05", "capabilities":{}, "clientInfo":{"name":"codex-um1646-schema-read", "version":"1"}}})
    response = receive(1)
    if "error" in response:
        raise RuntimeError("Assigned wrapper initialization refused")
    send({"jsonrpc":"2.0", "method":"notifications/initialized"})
    send({"jsonrpc":"2.0", "id":2, "method":"tools/list", "params":{}})
    response = receive(2)
    for tool in response.get("result", {}).get("tools", []):
        if tool.get("name") in wanted:
            print(json.dumps({"name":tool["name"], "inputSchema":tool.get("inputSchema")}))
finally:
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
