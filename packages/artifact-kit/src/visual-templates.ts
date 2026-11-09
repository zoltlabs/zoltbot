const source =
  "<details open><summary>Sources and assumptions</summary><p>Illustrative data only. Replace with inspected evidence, exact date bounds, timezone and commands or file references. Add a textual explanation in the chat.</p></details>";
const page = (title: string, body: string, script = "") =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="stylesheet" href="kit/v1/style.css"><main class="kit-stack"><header><p class="kit-kicker">Illustrative example</p><h1>${title}</h1></header>${body}${source}</main><script>${script}</script></html>`;

export const visualTemplates = {
  "repository-activity": page(
    "Repository activity",
    '<p>A snapshot of commits, filtered by author. Dates below are illustrative UTC commit dates.</p><label for="author">Author</label><select id="author"><option value="">All authors</option><option>Alex</option><option>Sam</option></select><p id="count" role="status">2 commits</p><ol class="kit-timeline"><li data-author="Alex"><time>2026-11-01</time> · Alex · <code>abc1234</code><p>Add settings</p></li><li data-author="Sam"><time>2026-11-02</time> · Sam · <code>def5678</code><p>Fix navigation</p></li></ol><p id="empty" hidden>No commits match these filters.</p>',
    'document.getElementById("author").addEventListener("change",e=>{let n=0;document.querySelectorAll("[data-author]").forEach(row=>{row.hidden=!!e.target.value&&row.dataset.author!==e.target.value;if(!row.hidden)n++;});document.getElementById("count").textContent=n+" commits";document.getElementById("empty").hidden=n!==0;});',
  ),
  "system-flow": page(
    "How the request flows",
    '<p>Read the steps in order. Expand each step for its responsibility and evidence.</p><ol class="kit-timeline"><li><details open><summary>1. Composer</summary><p>Collects the user input. Replace with an inspected file and symbol.</p></details></li><li><details><summary>2. Durable queue</summary><p>Preserves the request across reconnects. Label inferred relationships explicitly.</p></details></li><li><details><summary>3. Provider</summary><p>Runs the native session. Cite inspected code; do not imply unobserved execution.</p></details></li></ol>',
  ),
  "ui-variants": page(
    "Compare diff indicators",
    '<p>Illustrative diff: 12 additions, 3 deletions. Pick a variant to discuss in the chat; selection takes no app action.</p><fieldset class="kit-stack"><legend>Choose a variant</legend><label><input type="radio" name="variant" value="Numbers" checked> Numbers: +12 −3</label><label><input type="radio" name="variant" value="Words"> Words: 12 added · 3 removed</label><label><input type="radio" name="variant" value="Blocks"> Blocks: ▰▰▰ +12 / ▱ −3</label><label><input type="radio" name="variant" value="Compact"> Compact: Δ15 (+12 / −3)</label></fieldset><p role="status" id="selection">Selected: Numbers</p><p>Use the same labels in responsive phone and desktop examples. Color must not be the only encoding.</p>',
    'document.querySelectorAll("input[name=variant]").forEach(input=>input.addEventListener("change",()=>{document.getElementById("selection").textContent="Selected: "+input.value;}));',
  ),
};
