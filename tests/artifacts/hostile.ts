/** Shared attacks for every artifact embedding surface; all endpoints are local test sinks. */
export function hostileArtifact(sink: string) {
  const url = JSON.stringify(sink);
  return `<!doctype html><html><head><link rel="prefetch" href="${sink}/prefetch">
<style>body{background-image:url('${sink}/css')}</style></head><body>
<h1>Hostile fixture</h1><img src="${sink}/image" alt="network probe">
<form action="${sink}/form" method="post"><input name="fixture" value="probe"></form>
<script>
const sink=${url};
const checks={};
try{fetch(sink+'/fetch').catch(()=>{})}catch{}
try{new WebSocket(sink.replace('http:','ws:')+'/socket')}catch{}
try{document.forms[0].submit()}catch{}
try{checks.parent=parent.document.title}catch{checks.parent='denied'}
try{checks.storage=localStorage.getItem('fixture')}catch{checks.storage='denied'}
try{checks.sessionStorage=sessionStorage.getItem('fixture')}catch{checks.sessionStorage='denied'}
try{indexedDB.open('fixture');checks.indexedDB='allowed'}catch{checks.indexedDB='denied'}
try{checks.opener=opener?.document.title}catch{checks.opener='denied'}
try{window.open(sink+'/popup')}catch{}
try{top.location=sink+'/top'}catch{}
try{parent.postMessage({type:'zolt-artifact',action:'connection',token:'spoofed'},'*')}catch{}
window.fixtureChecks=checks;
</script></body></html>`;
}
export const hostileSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><script>window.svgScriptRan=true;parent.postMessage({type:'zolt-artifact',action:'connection'},'*')</script><rect width="100" height="100" fill="red"/></svg>`;
