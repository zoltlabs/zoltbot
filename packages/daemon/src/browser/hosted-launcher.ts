// B2: the launcher tail for a browser the daemon runs. `open` attaches the CLI to that browser
// and goes to the page; `close` detaches. Without the daemon's endpoint it behaves as before.
// B3: while the owner controls the browser, commands wait; notes for the agent print afterwards.
import path from "node:path";
import type { BrowserBinding } from "./runtime.js";
import { controlFile, notesFile } from "./takeover-files.js";

/** How long a command waits for the owner before asking the agent to try again. */
export const CONTROL_WAIT_MS = 90_000;
/** Notes printed after one command: at most 3, about 400 tokens. */
const NOTES = { count: 3, chars: 1600 };

/** `header` is the plain launcher's text up to its spawn: validation, env and `extra`. */
export function hostedLauncherSource(b: BrowserBinding, header: string, cli: string): string {
  const files = {
    endpoint: path.join(b.home, "endpoint.json"),
    attached: path.join(b.home, "attached.json"),
    control: controlFile(b),
    notes: notesFile(b),
  };
  return `${header}const fs=await import('node:fs');
const files=${JSON.stringify(files)};
const run=(argv)=>new Promise((done)=>{const child=spawn(${JSON.stringify(process.execPath)},[${JSON.stringify(cli)},${JSON.stringify(`-s=${b.session}`)},...argv],{cwd:${JSON.stringify(b.artifactRoot)},env,stdio:['inherit','pipe','pipe']});let out='',err='';child.stdout.on('data',c=>{out+=c;if(out.length>1048576){child.kill();out='[browser output exceeded limit]'}});child.stderr.on('data',c=>{if(err.length<65536)err+=c});child.on('error',()=>done({code:1,out:'',err:'browser_runtime_failed'}));child.on('exit',code=>done({code:code??1,out,err}))});
const started=Date.now();
while(fs.existsSync(files.control)){if(Date.now()-started>${CONTROL_WAIT_MS}){process.stderr.write('The owner is using the browser. Run the command again in a minute.\\n');process.exit(75)}await new Promise(r=>setTimeout(r,500))}
let endpoint;try{endpoint=JSON.parse(fs.readFileSync(files.endpoint,'utf8')).endpoint}catch{}
let attached;try{attached=JSON.parse(fs.readFileSync(files.attached,'utf8')).endpoint}catch{}
let argv=[...args,...extra];
if(endpoint&&args[0]==='open'){if(attached!==endpoint){const a=await run(['attach','--endpoint='+endpoint]);if(a.code){process.stderr.write(redact(a.err||a.out));process.exit(a.code)}fs.writeFileSync(files.attached,JSON.stringify({endpoint}),{mode:0o600})}argv=['goto',args[1]??'about:blank']}
else if(endpoint&&args[0]==='close'&&attached){fs.rmSync(files.attached,{force:true});argv=['detach']}
const result=await run(argv);
process.stdout.write(redact(result.out));process.stderr.write(redact(result.err));
let notes=[];try{const raw=fs.readFileSync(files.notes,'utf8');fs.rmSync(files.notes,{force:true});notes=raw.split('\\n').flatMap(l=>{try{const t=JSON.parse(l).text;return typeof t==='string'?[t]:[]}catch{return[]}})}catch{}
if(notes.length){let text=notes.slice(-${NOTES.count}).join('\\n');if(text.length>${NOTES.chars})text=text.slice(0,${NOTES.chars})+'…';process.stdout.write('\\n'+redact(text)+'\\n')}
process.exitCode=result.code;
`;
}
