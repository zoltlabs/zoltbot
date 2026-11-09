import subprocess,os,pathlib,json,threading,queue,signal,http.server
root=pathlib.Path.cwd(); traffic=[];token='zoltbot-spike-token'
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  body=json.loads(self.rfile.read(int(self.headers.get('Content-Length','0'))));authorized=self.headers.get('Authorization')=='Bearer '+token;traffic.append({'method':body.get('method'),'authorized':authorized})
  if not authorized:self.send_response(401);self.end_headers();return
  if 'id' not in body:self.send_response(202);self.end_headers();return
  if body['method']=='initialize':result={'protocolVersion':body.get('params',{}).get('protocolVersion','2025-11-25'),'capabilities':{'tools':{}},'serverInfo':{'name':'zoltbot-spike','version':'0.1.0'}}
  elif body['method']=='tools/list':result={'tools':[{'name':'spike_ping','description':'A prompt free spike tool','inputSchema':{'type':'object','properties':{}}}]}
  else:result={}
  payload=json.dumps({'jsonrpc':'2.0','id':body['id'],'result':result}).encode();self.send_response(200);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler);threading.Thread(target=server.serve_forever,daemon=True).start();url='http://127.0.0.1:'+str(server.server_port)+'/mcp'
env={k:v for k,v in os.environ.items() if k in ['PATH','LANG','LC_ALL']};env.update(HOME=str(root/'.cache/spikes/home'),CODEX_HOME=str(root/'.cache/spikes/codex-home'),TMPDIR=str(root/'.cache/spikes/tmp'))
p=subprocess.Popen([str(root/'.cache/spikes/codex-cli/node_modules/.bin/codex'),'app-server','--stdio','-c','analytics.enabled=false'],cwd=root/'.cache/spikes/workspace',env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,text=True,start_new_session=True)
q=queue.Queue();records=[]
def read():
 for line in p.stdout:
  try:q.put(json.loads(line))
  except:pass
threading.Thread(target=read,daemon=True).start()
def clean(x):
 if isinstance(x,dict):return {k:('[REDACTED]' if v is not None and k.lower() in ['servername','installationid','environmentid','baseinstructions','developerinstructions','account','email','accesstoken','authorization'] and not isinstance(v,bool) else clean(v)) for k,v in x.items()}
 if isinstance(x,list):return [clean(v) for v in x]
 if isinstance(x,str):return x.replace(token,'[REDACTED]').replace(url,'http://127.0.0.1:43123/mcp').replace(str(root),'/work/repo').replace('/Users/' + __import__('getpass').getuser(),'/home/user')
 return x
def send(r):p.stdin.write(json.dumps(r)+'\n');p.stdin.flush();records.append({'direction':'stdin','message':clean(r)})
def wait(id):
 while True:
  value=q.get(timeout=20);records.append({'direction':'stdout','message':clean(value)})
  if value.get('id')==id:return value
try:
 send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'zoltbot-spike','title':'Zoltbot protocol spike','version':'0.1.0'},'capabilities':{'experimentalApi':False}}});wait(1);send({'method':'initialized','params':{}})
 send({'id':2,'method':'thread/start','params':{'cwd':str(root/'.cache/spikes/workspace'),'approvalPolicy':'on-request','sandbox':'read-only','serviceName':'zoltbot','config':{'mcp_servers':{'zoltbot':{'url':url,'http_headers':{'Authorization':'Bearer '+token},'required':True}}}}});r=wait(2)
 if 'result'in r:
  native=r['result']['thread']['id'];send({'id':3,'method':'mcpServerStatus/list','params':{'threadId':native,'detail':'full'}});s=wait(3)
  print(json.dumps({'threadStarted':True,'statusResultKeys':list(s.get('result',{})),'statusErrorCode':s.get('error',{}).get('code'),'httpTraffic':traffic}))
 else:print(json.dumps({'threadStarted':False,'errorCode':r.get('error',{}).get('code'),'httpTraffic':traffic}))
finally:
 p.stdin.close();os.killpg(p.pid,signal.SIGTERM);p.wait(timeout=5);server.shutdown();folder=root/'fixtures/codex/0.164.0';(folder/'thread-mcp-no-auth.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in records));(folder/'mcp-http-no-auth.json').write_text(json.dumps(traffic,indent=2)+'\n')
