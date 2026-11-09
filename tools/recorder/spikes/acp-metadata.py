"""Probe real ACP initialization and session creation with isolated configuration."""
import argparse
import http.server
import json
import os
from pathlib import Path
import queue
import re
import signal
import subprocess
import threading
import time

parser = argparse.ArgumentParser()
parser.add_argument("provider", choices=["cursor", "opencode", "grok"])
provider = parser.parse_args().provider
root = Path.cwd()
version = {"cursor": "2026.10.22-27dcf5f", "opencode": "1.19.4", "grok": "1.0.70"}[provider]
home = root / f".cache/spikes/{provider}-home"
work = root / ".cache/spikes/acp-metadata-workspace"
for folder in (home, work, root / ".cache/spikes/tmp"):
    folder.mkdir(parents=True, exist_ok=True)
if not (work / ".git").exists():
    subprocess.run(["git", "init", "--quiet", str(work)], check=True)
traffic = []
token = "synthetic-zoltbot-mcp-token"
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        authorized = self.headers.get("Authorization") == "Bearer " + token
        traffic.append({"method": body.get("method"), "authorized": authorized})
        if not authorized:
            self.send_response(401)
            self.end_headers()
            return
        if "id" not in body:
            self.send_response(202)
            self.end_headers()
            return
        if body["method"] == "initialize":
            result = {"protocolVersion": body.get("params", {}).get("protocolVersion", "2025-11-25"), "capabilities": {"tools": {}}, "serverInfo": {"name": "zoltbot-spike", "version": "1"}}
        elif body["method"] == "tools/list":
            result = {"tools": [{"name": "spike_ping", "description": "Synthetic local spike", "inputSchema": {"type": "object", "properties": {}}}]}
        else:
            result = {}
        data = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_port}/mcp"
leader_socket = home / ".grok/leader-zoltbot-spike.sock"
command = {
    "cursor": [str(root / ".cache/spikes/cursor-current/dist-package/cursor-agent"), "acp"],
    "opencode": [str(root / ".cache/spikes/opencode-cli/node_modules/.pnpm/opencode-darwin-arm64@1.19.4/node_modules/opencode-darwin-arm64/bin/opencode"), "acp"],
    "grok": [str(root / ".cache/spikes/grok-cli/grok"), "--no-auto-update", "agent", "stdio", "--leader-socket", str(leader_socket)],
}[provider]
env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(root / ".cache/spikes/tmp"), "XDG_CONFIG_HOME": str(home / "config"), "XDG_DATA_HOME": str(home / "data"), "XDG_CACHE_HOME": str(home / "cache"), "XDG_STATE_HOME": str(home / "state")}
process = subprocess.Popen(command, cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True)
messages = queue.Queue()
records = []
def read():
    for line in process.stdout:
        try:
            messages.put(json.loads(line))
        except json.JSONDecodeError:
            messages.put({"type": "non_json_output", "length": len(line)})
threading.Thread(target=read, daemon=True).start()
def clean(value):
    if isinstance(value, dict):
        return {key: ("[REDACTED]" if re.search(r"^(?:authorization|token|email|account|username|installationId|serverName|accessToken|hostname|agentId|agentInstanceId)$", key, re.I) else clean(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [clean(item) for item in value]
    if isinstance(value, str):
        return re.sub(r"/Users/[^/\s]+", "/home/user", value.replace(str(root), "<repo>").replace(token, "[REDACTED]").replace(url, "http://127.0.0.1:43123/mcp"))
    return value
def request(request_id, method, params):
    message = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}
    records.append({"direction": "stdin", "message": clean(message)})
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        try:
            message = messages.get(timeout=max(.01, deadline - time.monotonic()))
        except queue.Empty:
            raise RuntimeError("acp_response_timeout") from None
        records.append({"direction": "stdout", "message": clean(message)})
        if message.get("id") == request_id and ("result" in message or "error" in message):
            print(provider, method, "result" if "result" in message else f"error-code:{message['error'].get('code')}")
            return message
    raise RuntimeError("acp_response_timeout")
try:
    initialized = request(1, "initialize", {"protocolVersion": 1, "clientInfo": {"name": "zoltbot-spike", "version": "0.1.0"}, "clientCapabilities": {"fs": {"readTextFile": False, "writeTextFile": False}, "terminal": False}})
    if "result" in initialized:
        created = request(2, "session/new", {"cwd": str(work), "mcpServers": [{"type": "http", "name": "zoltbot", "url": url, "headers": [{"name": "Authorization", "value": "Bearer " + token}]}]})
        if provider == "opencode" and "result" in created:
            configs = created["result"].get("configOptions", [])
            mode = next((option for option in configs if option.get("category") == "mode"), None)
            if mode and any(option.get("value") == "plan" for option in mode.get("options", [])):
                request(3, "session/set_config_option", {"sessionId": created["result"]["sessionId"], "configId": mode["id"], "value": "plan"})
        time.sleep(2)
        while not messages.empty():
            records.append({"direction": "stdout", "message": clean(messages.get_nowait())})
finally:
    try:
        os.killpg(process.pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    if provider == "grok":
        subprocess.run([command[0], "--no-auto-update", "leader", "kill", "--leader-socket", str(leader_socket)], cwd=work, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    server.shutdown()
    destination = root / f"fixtures/{provider}/{version}"
    destination.mkdir(parents=True, exist_ok=True)
    (destination / "initialize-session-no-auth.jsonl").write_text("\n".join(json.dumps(record) for record in records) + "\n")
    (destination / "mcp-http-no-auth.json").write_text(json.dumps(traffic, indent=2) + "\n")
