"""Record isolated Pi RPC metadata and an extension dialog without model inference."""
import http.server
import json
import os
from pathlib import Path
import queue
import subprocess
import threading

root = Path.cwd()
work = root / ".cache/spikes/pi-workspace"
home = root / ".cache/spikes/pi-home"
for folder in (work, home, root / ".cache/spikes/tmp"):
    folder.mkdir(parents=True, exist_ok=True)
extension = work / "spike-extension.ts"
traffic = []
token = "zoltbot-synthetic-spike-token"
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
            result = {"tools": [{"name": "spike_ping", "description": "Synthetic protocol check", "inputSchema": {"type": "object", "properties": {}}}]}
        else:
            result = {}
        payload = json.dumps({"jsonrpc": "2.0", "id": body["id"], "result": result}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = f"http://127.0.0.1:{server.server_port}/mcp"
extension.write_text('''export default function(pi) {
  pi.registerMcpServer("zoltbot", { url: process.env.ZOLTBOT_SPIKE_URL, headers: { Authorization: "Bearer " + process.env.ZOLTBOT_SPIKE_TOKEN }, exposure: "direct" });
  pi.registerCommand("zoltbot_tools", { description: "Synthetic tool discovery", handler: async (_args, ctx) => {
    ctx.ui.notify(JSON.stringify(pi.getAllTools().map(tool => tool.name)), "info");
  }});
  pi.registerCommand("zoltbot_spike", { description: "Synthetic protocol check", handler: async (_args, ctx) => {
    const allowed = await ctx.ui.confirm("Zoltbot spike", "Allow a synthetic action?", { timeout: 5000 });
    ctx.ui.notify(allowed ? "spike_allowed" : "spike_denied", "info");
  }});
}''')
env = {
    "PATH": os.environ["PATH"], "HOME": str(home),
    "TMPDIR": str(root / ".cache/spikes/tmp"),
    "PI_CODING_AGENT_DIR": str(home / "agent"),
    "ZOLTBOT_SPIKE_URL": url, "ZOLTBOT_SPIKE_TOKEN": token,
}
args = ["node", str(root / ".cache/spikes/pi-cli/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        "--mode", "rpc", "--no-extensions", "--extension", "builtin:mcp", "--extension", str(extension),
        "--no-skills", "--no-prompt-templates", "--no-themes", "--session-dir", str(home / "sessions")]
process = subprocess.Popen(args, cwd=work, env=env, stdin=subprocess.PIPE,
                           stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
messages = queue.Queue()
def read():
    for line in process.stdout:
        try:
            messages.put(json.loads(line))
        except json.JSONDecodeError:
            messages.put({"type": "invalid_json"})
threading.Thread(target=read, daemon=True).start()
records = []
def send(message):
    records.append({"direction": "stdin", "message": message})
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()
def request(kind, **params):
    request_id = f"spike-{len(records)}"
    send({"id": request_id, "type": kind, **params})
    while True:
        message = messages.get(timeout=15)
        records.append({"direction": "stdout", "message": message})
        if message.get("type") == "extension_ui_request" and message.get("method") == "confirm":
            send({"type": "extension_ui_response", "id": message["id"], "confirmed": False})
        if message.get("type") == "response" and message.get("id") == request_id:
            if not message.get("success"):
                raise RuntimeError("rpc_request_failed")
            print(kind, "success")
            return message.get("data", {})
try:
    request("get_state")
    models = request("get_available_models")
    request("get_session_stats")
    request("set_session_name", name="Zoltbot isolated spike")
    request("get_state")
    result = request("prompt", message="/zoltbot_spike")
    if result.get("disposition") != "handled":
        raise RuntimeError("extension_command_not_handled")
    request("get_session_stats")
    request("prompt", message="/zoltbot_tools")
finally:
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    server.shutdown()
    capture = "\n".join(json.dumps(record) for record in records).replace(str(root), "<repo>").replace(token, "[REDACTED]").replace(url, "http://127.0.0.1:43123/mcp") + "\n"
    destination = root / "fixtures/pi/1.4.0/rpc-no-auth.jsonl"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(capture)
    (destination.parent / "mcp-http-no-auth.json").write_text(json.dumps(traffic, indent=2) + "\n")
