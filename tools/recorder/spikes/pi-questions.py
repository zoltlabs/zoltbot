"""Probe isolated real Pi select and input RPC with no model or credentials."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import signal
import threading

root = Path.cwd()
bundled = "--bundled" in sys.argv
prefix = "pi-bundled-question" if bundled else "pi-question"
work = root / f".cache/spikes/{prefix}-workspace"
home = root / f".cache/spikes/{prefix}-home"
tmp = root / ".cache/spikes/tmp"
for folder in (work, home, tmp):
    folder.mkdir(parents=True, exist_ok=True)
extension = work / "questions.ts"
extension.write_text('''export default function(pi) {
  pi.registerCommand("zoltbot_questions", { description: "Synthetic question wire check", handler: async (args, ctx) => {
    const selected = await ctx.ui.select("Choose synthetic option", ["First", "Second"], { timeout: 5000 });
    const input = await ctx.ui.input("Synthetic input", "Enter synthetic text", { timeout: 5000 });
    ctx.ui.notify(JSON.stringify({ selected: selected ?? null, input: input ?? null }), "info");
  }});
}''')
if bundled:
    source = json.dumps(str(root / "packages/adapters/pi/src/extension.ts"))
    extension.write_text("import { registerQuestionTool } from " + source + ";\n" + '''export default function(pi) {
      let tool;
      registerQuestionTool({ registerTool(value) { tool = value; pi.registerTool(value); } });
      pi.registerCommand("zoltbot_questions", { description: "Bundled question tool check", handler: async (_args, ctx) => {
        if (!pi.getAllTools().some(candidate => candidate.name === "zoltbot_ask_human")) throw new Error("question_tool_not_registered");
        const selected = await tool.execute("select-call", { question: "Choose synthetic option", options: ["First", "Second"] }, undefined, undefined, ctx);
        const input = await tool.execute("input-call", { question: "Synthetic input" }, undefined, undefined, ctx);
        ctx.ui.notify(JSON.stringify({ selected: JSON.parse(selected.content[0].text), input: JSON.parse(input.content[0].text) }), "info");
      }});
    }''')
env = {"PATH": os.environ["PATH"], "HOME": str(home), "TMPDIR": str(tmp),
       "PI_CODING_AGENT_DIR": str(home / "agent")}
args = ["node", str(root / ".cache/spikes/pi-cli/node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        "--mode", "rpc", "--no-extensions", "--extension", str(extension), "--no-skills",
        "--no-prompt-templates", "--no-themes", "--session-dir", str(home / "sessions")]
process = subprocess.Popen(args, cwd=work, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                           stderr=subprocess.DEVNULL, text=True, bufsize=1, start_new_session=True)
messages = queue.Queue()
records = []
def read():
    for line in process.stdout:
        messages.put(json.loads(line))
threading.Thread(target=read, daemon=True).start()
def send(message):
    records.append({"direction": "stdin", "message": message})
    process.stdin.write(json.dumps(message) + "\n")
    process.stdin.flush()
def request(kind, cancel=False, **params):
    request_id = f"question-spike-{len(records)}"
    send({"id": request_id, "type": kind, **params})
    while True:
        message = messages.get(timeout=15)
        records.append({"direction": "stdout", "message": message})
        if message.get("type") == "extension_ui_request" and message.get("method") in ("select", "input"):
            response = {"type": "extension_ui_response", "id": message["id"]}
            response.update({"cancelled": True} if cancel else {"value": "Second" if message["method"] == "select" else "Synthetic answer"})
            send(response)
        if message.get("type") == "response" and message.get("id") == request_id:
            if not message.get("success"):
                raise RuntimeError("question_rpc_failed")
            return message.get("data", {})
try:
    before = request("get_session_stats")
    for cancelled in (False, True):
        outcome = request("prompt", cancel=cancelled, message="/zoltbot_questions")
        if outcome.get("disposition") != "handled":
            raise RuntimeError("question_command_not_handled")
    after = request("get_session_stats")
    for stats in (before, after):
        if any(stats[key] != 0 for key in ("userMessages", "assistantMessages", "toolCalls", "cost")) or stats["tokens"]["total"] != 0:
            raise RuntimeError("unexpected_model_activity")
    print("Verified select and input answer and cancellation with zero model activity")
finally:
    os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.wait()
    capture = "\n".join(json.dumps(record) for record in records).replace(str(root), "<repo>") + "\n"
    name = "bundled-questions-no-auth.jsonl" if bundled else "questions-no-auth.jsonl"
    (root / "fixtures/pi/1.4.0" / name).write_text(capture)
