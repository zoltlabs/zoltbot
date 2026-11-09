"""Verify the bundled gate in real Pi with a deterministic loopback provider."""
import hashlib
import http.server
import json
import os
from pathlib import Path
import queue
import time
import subprocess
import threading

root = Path.cwd()
work = root / ".cache/spikes/pi-bundled-workspace"
home = root / ".cache/spikes/pi-bundled-home"
for folder in (work, home, root / ".cache/spikes/tmp"):
    folder.mkdir(parents=True, exist_ok=True)
extension = work / "spike-extension.ts"
traffic = []
completion_count = 0
reply_to_dialog = True
token = "zoltbot-synthetic-spike-token"
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
        global completion_count
        if self.path.endswith("/chat/completions"):
            completion_count += 1
            tool = body["messages"][-1].get("role") == "user"
            if tool:
                delta = {"role": "assistant", "tool_calls": [{"index": 0, "id": f"call-spike-{completion_count}", "type": "function", "function": {"name": "bash", "arguments": json.dumps({"command": "printf forbidden > synthetic-marker"})}}]}
            else:
                delta = {"role": "assistant", "content": "Local fixture complete."}
            chunk = {"id": "synthetic", "object": "chat.completion.chunk", "created": 0, "model": "spike", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]}
            terminal = {**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls" if tool else "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 2, "total_tokens": 12}}
            payload = ("data: " + json.dumps(chunk) + "\n\ndata: " + json.dumps(terminal) + "\n\ndata: [DONE]\n\n").encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            traffic.append({"method": "local_completion", "toolRequested": tool})
            return
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
  pi.registerProvider("zoltbot-spike", { baseUrl: process.env.ZOLTBOT_SPIKE_URL.replace("/mcp", "/v1"), apiKey: "synthetic", api: "openai-completions", models: [{ id: "spike", name: "Synthetic local fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000 }] });
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return { block: true, reason: "Synthetic gate only allows bash checks" };
    try {
      const allowed = await ctx.ui.confirm("Zoltbot tool gate", event.input.command, { timeout: 500 });
      if (allowed !== true) return { block: true, reason: "Zoltbot gate denied" };
    } catch { return { block: true, reason: "Zoltbot gate unavailable" }; }
  });
  pi.registerMcpServer("zoltbot", { url: process.env.ZOLTBOT_SPIKE_URL, headers: { Authorization: "Bearer " + process.env.ZOLTBOT_SPIKE_TOKEN }, exposure: "direct" });
  pi.registerCommand("zoltbot_tools", { description: "Synthetic tool discovery", handler: async (_args, ctx) => {
    ctx.ui.notify(JSON.stringify(pi.getAllTools().map(tool => tool.name)), "info");
  }});
  pi.registerCommand("zoltbot_spike", { description: "Synthetic protocol check", handler: async (_args, ctx) => {
    const allowed = await ctx.ui.confirm("Zoltbot spike", "Allow a synthetic action?", { timeout: 5000 });
    ctx.ui.notify(allowed ? "spike_allowed" : "spike_denied", "info");
  }});
}''')
provider_line = next(line for line in extension.read_text().splitlines() if "pi.registerProvider(" in line)
extension.write_text("export default function(pi) {\n" + provider_line + "\n}")
source = (root / "packages/adapters/pi/src/extension.ts").read_bytes()
bundled = work / "zoltbot-gate.ts"
bundled.write_bytes(source)
if hashlib.sha256(bundled.read_bytes()).digest() != hashlib.sha256(source).digest():
    raise RuntimeError("extension_hash_mismatch")
config_path = work / "gate.json"
config_path.write_text(json.dumps({"profile": "workspace_write", "cwd": str(work), "hostMcp": {"url": url, "token": token}, "nonce": "bundled-spike"}))
config_path.chmod(0o600)
env = {
    "PATH": os.environ["PATH"], "HOME": str(home),
    "TMPDIR": str(root / ".cache/spikes/tmp"),
    "PI_CODING_AGENT_DIR": str(home / "agent"),
    "ZOLTBOT_PI_CONFIG": str(config_path),
    "ZOLTBOT_SPIKE_URL": url, "ZOLTBOT_SPIKE_TOKEN": token,
}
args = ["node", str(root / ".cache/spikes/pi-cli/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        "--mode", "rpc", "--provider", "zoltbot-spike", "--model", "spike", "--no-extensions", "--extension", "builtin:mcp", "--extension", str(extension), "--extension", str(bundled),
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
            send({"type": "extension_ui_response", "id": message["id"], **({"confirmed": False} if reply_to_dialog else {"cancelled": True})})
        if message.get("type") == "response" and message.get("id") == request_id:
            if not message.get("success"):
                raise RuntimeError("rpc_request_failed")
            print(kind, "success")
            return message.get("data", {})
try:
    commands = request("get_commands").get("commands", [])
    if not any(command.get("name") == "zoltbot_ready" and command.get("sourceInfo", {}).get("path") == str(bundled) for command in commands):
        raise RuntimeError("bundled_gate_unavailable")
    if request("prompt", message="/zoltbot_ready").get("disposition") != "handled":
        raise RuntimeError("gate_probe_not_handled")
    if not any(record["message"].get("message") == "zoltbot_ready:bundled-spike" for record in records):
        raise RuntimeError("gate_probe_not_confirmed")
    for should_reply in (True, False):
        reply_to_dialog = should_reply
        result = request("prompt", message="Synthetic tool gate check")
        if result.get("disposition") != "started":
            raise RuntimeError("local_turn_not_started")
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            message = messages.get(timeout=15)
            records.append({"direction": "stdout", "message": message})
            if message.get("type") == "extension_ui_request" and message.get("method") == "confirm":
                send({"type": "extension_ui_response", "id": message["id"], **({"confirmed": False} if should_reply else {"cancelled": True})})
            if message.get("type") == "agent_settled":
                break
        else:
            raise RuntimeError("local_turn_not_settled")
        if (work / "synthetic-marker").exists():
            raise RuntimeError("denied_tool_executed")
    request("get_session_stats")
finally:
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    server.shutdown()
    capture = "\n".join(json.dumps(record) for record in records).replace(str(root), "<repo>").replace(token, "[REDACTED]").replace(url, "http://127.0.0.1:43123/mcp") + "\n"
    destination = root / "fixtures/pi/1.4.0/bundled-gate-local-provider.jsonl"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(capture)
    (destination.parent / "bundled-gate-http-local.json").write_text(json.dumps(traffic, indent=2) + "\n")
