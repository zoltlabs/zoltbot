"""Prompt free Claude startup probe. Run only from the repository root."""
import subprocess, os, pathlib, json, threading, queue, signal, http.server, time, uuid
root = pathlib.Path.cwd()
traffic = []
token = 'zoltbot-spike-token'
native = str(uuid.uuid4())
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self, *args): pass
 def do_POST(self):
  body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))))
  authorized = self.headers.get('Authorization') == 'Bearer ' + token
  traffic.append({'method': body.get('method'), 'authorized': authorized})
  if not authorized: self.send_response(401); self.end_headers(); return
  if 'id' not in body: self.send_response(202); self.end_headers(); return
  if body['method'] == 'initialize': result = {'protocolVersion': body.get('params', {}).get('protocolVersion', '2025-11-25'), 'capabilities': {'tools': {}}, 'serverInfo': {'name': 'zoltbot-spike', 'version': '0.1.0'}}
  elif body['method'] == 'tools/list': result = {'tools': [{'name': 'spike_ping', 'description': 'A prompt free spike tool', 'inputSchema': {'type': 'object', 'properties': {}}}]}
  else: result = {}
  payload = json.dumps({'jsonrpc': '2.0', 'id': body['id'], 'result': result}).encode()
  self.send_response(200); self.send_header('Content-Type', 'application/json'); self.send_header('Content-Length', str(len(payload))); self.end_headers(); self.wfile.write(payload)
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
url = 'http://127.0.0.1:' + str(server.server_port) + '/mcp'
config = root / '.cache/spikes/claude-mcp.json'
config.write_text(json.dumps({'mcpServers': {'zoltbot': {'type': 'http', 'url': url, 'headers': {'Authorization': 'Bearer ' + token}}}}))
config.chmod(0o600)
env = {k: v for k, v in os.environ.items() if k in ['PATH', 'LANG', 'LC_ALL']}
env.update(HOME=str(root / '.cache/spikes/home'), CLAUDE_CONFIG_DIR=str(root / '.cache/spikes/claude-home'), TMPDIR=str(root / '.cache/spikes/tmp'))
args = ['claude', '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--replay-user-messages', '--session-id', native, '--permission-mode', 'default', '--permission-prompts', 'host', '--strict-mcp-config', '--mcp-config', str(config), '--allowedTools', 'mcp__zoltbot__*']
p = subprocess.Popen(args, cwd=root / '.cache/spikes/workspace', env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, start_new_session=True)
q = queue.Queue()
def read():
 for line in p.stdout:
  try: q.put(json.loads(line))
  except: pass
threading.Thread(target=read, daemon=True).start()
def clean(x):
 if isinstance(x, dict): return {k: ('[REDACTED]' if v is not None and k.lower() in ['account', 'email', 'username', 'organization', 'authorization', 'installationid', 'machineid'] else 0 if k == 'pid' else clean(v)) for k, v in x.items()}
 if isinstance(x, list): return [clean(v) for v in x]
 if isinstance(x, str): return x.replace(token, '[REDACTED]').replace(native, '11111111-1111-4111-8111-111111111111').replace(url, 'http://127.0.0.1:43123/mcp').replace(str(root), '/work/repo').replace('/Users/' + __import__('getpass').getuser(), '/home/user')
 return x
request = {'type': 'control_request', 'request_id': 'initialize-1', 'request': {'subtype': 'initialize'}}
records = [{'direction': 'stdin', 'message': request}]
try:
 p.stdin.write(json.dumps(request) + '\n'); p.stdin.flush()
 deadline = time.monotonic() + 4
 while time.monotonic() < deadline:
  try: records.append({'direction': 'stdout', 'message': clean(q.get(timeout=0.25))})
  except queue.Empty: pass
 for request_id, request_body in [
  ('mcp-status-1', {'subtype': 'mcp_status'}),
  ('context-1', {'subtype': 'get_context_usage', 'detail': 'summary'}),
  ('interrupt-1', {'subtype': 'interrupt'}),
  ('unknown-1', {'subtype': 'zoltbot_unknown_spike'}),
 ]:
  request = {'type': 'control_request', 'request_id': request_id, 'request': request_body}
  records.append({'direction': 'stdin', 'message': request})
  p.stdin.write(json.dumps(request) + '\n'); p.stdin.flush()
 deadline = time.monotonic() + 3
 while time.monotonic() < deadline:
  try: records.append({'direction': 'stdout', 'message': clean(q.get(timeout=0.25))})
  except queue.Empty: pass
 response = next((r['message'] for r in records if r['message'].get('type') == 'control_response'), {})
 payload = response.get('response', {}).get('response', {})
 print(json.dumps({'stdoutFrames': sum(r['direction'] == 'stdout' for r in records), 'permissionMode': payload.get('current_permission_mode'), 'sessionState': payload.get('session_state'), 'systemInit': any(r['message'].get('type') == 'system' and r['message'].get('subtype') == 'init' for r in records), 'httpTraffic': traffic, 'controls': [{'requestId': r['message'].get('response', {}).get('request_id'), 'subtype': r['message'].get('response', {}).get('subtype'), 'resultKeys': list(r['message'].get('response', {}).get('response', {}))} for r in records if r['message'].get('type') == 'control_response']}))
finally:
 p.stdin.close()
 try: p.wait(timeout=3)
 except subprocess.TimeoutExpired: os.killpg(p.pid, signal.SIGTERM); p.wait(timeout=5)
 server.shutdown()
 folder = root / 'fixtures/claude/2.1.299'
 (folder / 'initialize-mcp-no-auth.jsonl').write_text(''.join(json.dumps(r) + '\n' for r in records))
 (folder / 'mcp-http-no-auth.json').write_text(json.dumps(traffic, indent=2) + '\n')
