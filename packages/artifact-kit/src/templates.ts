import { visualTemplates } from "./visual-templates.js";

const shell = (title: string, body: string, scripts = "") =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="kit/v1/style.css"><main class="kit-stack">${body}</main><script src="kit/v1/components.js"></script>${scripts}</html>`;
const templates = {
  ...visualTemplates,
  comparison: shell(
    "Compare options",
    '<header><p class="kit-kicker">Decision brief</p><h1>Choose the right approach</h1><p class="kit-muted">Replace these examples with evidence, tradeoffs and a recommendation.</p></header><div class="kit-table-wrap kit-card"><table><caption>Options at a glance</caption><thead><tr><th scope="col">Option</th><th scope="col">Strength</th><th scope="col">Tradeoff</th></tr></thead><tbody><tr><th scope="row">Option A</th><td>Fast to start</td><td>Less flexibility</td></tr><tr><th scope="row">Option B</th><td>More control</td><td>More setup</td></tr></tbody></table></div><aside class="kit-callout"><h2>Recommendation</h2><p>Explain the recommendation and what would change it.</p></aside>',
  ),
  proposal: shell(
    "A proposal",
    '<header><p class="kit-kicker">Proposal</p><h1>A focused next step</h1><p>State the problem and the concrete change you recommend.</p></header><section class="kit-card"><h2>Why now</h2><p>Add evidence and the cost of waiting.</p></section><section><h2>Delivery plan</h2><ol class="kit-timeline"><li><strong>Prove the approach</strong><p>Define the smallest useful experiment.</p></li><li><strong>Ship and measure</strong><p>Describe acceptance and ownership.</p></li></ol></section><details><summary>Risks and assumptions</summary><p>List the assumptions that need checking.</p></details>',
  ),
  metrics: shell(
    "Metrics explorer",
    '<header><p class="kit-kicker">Illustrative data</p><h1>Explore the trend</h1><p>Replace sample values and document their source.</p></header><div class="kit-grid"><div class="kit-card kit-stat"><strong id="total">60</strong><span>Sample total</span></div><div class="kit-card"><label for="scale">Scale <output id="scale-label">1</output></label><input id="scale" type="range" min="1" max="3" value="1" step="1"></div></div><section class="kit-card"><h2>Sample periods</h2><div class="kit-chart"><canvas id="trend" aria-label="Sample values: 10, 20, 30" role="img"></canvas></div></section>',
    '<script src="kit/v1/chart.js"></script><script>const chart=new Chart(document.getElementById("trend"),{type:"bar",data:{labels:["A","B","C"],datasets:[{label:"Sample",data:[10,20,30],backgroundColor:"#3155c6"}]},options:{responsive:true,maintainAspectRatio:false,animation:false}});document.getElementById("scale").addEventListener("input",event=>{const n=Number(event.target.value);chart.data.datasets[0].data=[10*n,20*n,30*n];chart.update();document.getElementById("total").textContent=String(60*n);document.getElementById("scale-label").textContent=String(n);});</script>',
  ),
  onboarding: shell(
    "Welcome",
    '<div class="kit-device kit-stack"><p class="kit-kicker">Step 1 of 3</p><h1>Welcome aboard</h1><p>Describe the value and ask only for what is needed.</p><button type="button" onclick="document.getElementById(\'next\').hidden=false">Continue</button><section id="next" hidden><h2>Your next step</h2><p>Replace this with the next screen or a local interaction.</p></section></div>',
  ),
  tool: shell(
    "A small calculator",
    '<header><p class="kit-kicker">Local tool</p><h1>Plan a useful estimate</h1><p>All calculations run locally.</p></header><form class="kit-card kit-stack" oninput="document.getElementById(\'answer\').value=String(Number(document.getElementById(\'quantity\').value)*Number(document.getElementById(\'rate\').value))"><label for="quantity">Quantity</label><input id="quantity" type="number" min="0" value="4"><label for="rate">Rate</label><input id="rate" type="number" min="0" value="25"><p>Total: <output id="answer">100</output></p></form>',
  ),
} as const;
export type ArtifactTemplate = keyof typeof templates;
export function artifactTemplate(name: string) {
  if (!Object.hasOwn(templates, name)) throw Error("artifact_template_not_found");
  return {
    kit: "v1",
    template: name,
    entry: "index.html",
    files: [{ path: "index.html", text: templates[name as ArtifactTemplate] }],
    guidance:
      "Replace illustrative content. Save with kit:v1. No network or storage. For design, save all HTML screens together with stable screen ids.",
  };
}
