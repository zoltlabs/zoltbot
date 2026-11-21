// B6: the agent's browser never pays on its own. Clicks on pay buttons are held until the owner
// confirms; approval clicks the button once.

/** Setting: hosts where the owner lets the agent pay without asking. Only the owner changes it. */
export const PURCHASE_ALLOW_SETTING = "browser.purchase.allow";

/** What the page reports about a held click. */
export interface PurchaseDetails {
  /** The button's accessible name. */
  text: string;
  /** A total read near the button, best effort. */
  total: string;
}

export function parsePurchase(value: unknown): PurchaseDetails | undefined {
  const row = (value ?? {}) as Record<string, unknown>;
  const clean = (v: unknown, max: number) =>
    typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "";
  const text = clean(row.text, 80);
  return text ? { text, total: clean(row.total, 40) } : undefined;
}

// Whole button names that pay or place an order. Lowercase, without trailing punctuation.
const PAY = [
  "place order",
  "place your order",
  "place order and pay",
  "pay",
  "pay now",
  "buy",
  "buy now",
  "buy it now",
  "complete purchase",
  "complete order",
  "complete payment",
  "confirm purchase",
  "confirm order",
  "confirm and pay",
  "confirm payment",
  "submit order",
  "submit payment",
  "make payment",
  "purchase",
  "order now",
  "checkout and pay",
  "subscribe and pay",
  "start subscription",
  "jetzt kaufen",
  "kaufen",
  "zahlungspflichtig bestellen",
  "jetzt bezahlen",
  "bezahlen",
  "bestellung abschicken",
  "kostenpflichtig bestellen",
  "commander",
  "passer la commande",
  "payer",
  "payer maintenant",
  "acheter",
  "acheter maintenant",
  "valider la commande",
  "comprar",
  "comprar ahora",
  "pagar",
  "pagar ahora",
  "realizar pedido",
  "finalizar compra",
  "confirmar pedido",
  "acquista",
  "acquista ora",
  "paga",
  "paga ora",
  "conferma ordine",
  "ordina",
  "bestellen",
  "nu kopen",
  "kopen",
  "betalen",
  "afrekenen",
  "finalizar pedido",
  "comprar agora",
  "pagar agora",
  "zapłać",
  "kup teraz",
  "kupuję i płacę",
  "zamawiam z obowiązkiem zapłaty",
  "köp",
  "betala",
  "køb",
  "betal",
  "osta",
  "maksa",
  "購入する",
  "購入",
  "注文を確定する",
  "注文を確定",
  "今すぐ購入",
  "支払う",
  "立即购买",
  "购买",
  "提交订单",
  "支付",
  "立即支付",
  "确认支付",
  "결제하기",
  "구매하기",
  "주문하기",
  "결제",
];
// "Pay $42.10", "Pay 42,10 €", "Buy for $5".
// Names that start like a payment: "Pay $42.10", "Pay with PayPal", "Confirm and pay", "Subscribe".
const PAY_PREFIX =
  /^(pay|buy|purchase|subscribe|place (your )?order|checkout and pay|book and pay|complete (purchase|order|booking|payment)|confirm (and pay|purchase|order|booking|payment)|start (subscription|trial and pay))\b/iu;
// A form that posts to a payment step.
const PAY_ACTION =
  /\/(pay|payment|payments|purchase|place[-_]?order|checkout\/(complete|submit|confirm|pay|place))(\/|\?|$)/i;

/**
 * Runs in every frame first. Holds clicks and submits that would pay, and reports them through
 * the binding captured here (later page scripts can't swap it, or the built-ins it uses). The
 * daemon answers by calling `__zoltbotPurchaseGo` with the secret only it and this script know.
 */
export const PURCHASE_SCRIPT = `(() => {
  if (window.__zoltbotPurchaseSeen) return;
  window.__zoltbotPurchaseSeen = true;
  const report = window.__zoltbotPurchase;
  if (typeof report !== 'function') return;
  const call = Function.prototype.call.bind(Function.prototype.call);
  const { has } = Set.prototype, { test } = RegExp.prototype, { matches, getAttribute, setAttribute, removeAttribute } = Element.prototype;
  const random = crypto.getRandomValues.bind(crypto);
  const path = Event.prototype.composedPath, prevent = Event.prototype.preventDefault, stop = Event.prototype.stopImmediatePropagation;
  const pay = new Set(${JSON.stringify(PAY)});
  const prefix = ${PAY_PREFIX.toString()};
  const action = ${PAY_ACTION.toString()};
  const clickable = 'button, [role=button], [role=link], a, input[type=submit], input[type=button], input[type=image], [onclick]';
  const attr = (el, name) => call(getAttribute, el, name);
  const labelled = (el) => { const ids = (attr(el, 'aria-labelledby') || '').split(/\\s+/).filter(Boolean); return ids.map((id) => document.getElementById(id)?.textContent || '').join(' '); };
  const name = (el) => (attr(el, 'aria-label') || labelled(el) || el.innerText || el.value || attr(el, 'title') || el.querySelector?.('img[alt]')?.alt || el.alt || '').replace(/\\s+/g, ' ').trim();
  // "Place order · $42.10", "Confirm & pay", "Place order (opens new window)".
  const plain = (text) => text.toLowerCase().replace(/&/g, 'and').replace(/\\s*\\(.*\\)\\s*$/, '').split(/\\s+[·•|–—-]\\s+/)[0].replace(/[.!…→›>]+$/u, '').trim();
  const posts = (form) => { try { return Boolean(form && call(test, action, new URL(form.action, location.href).pathname)); } catch { return false; } };
  const target = (event) => { for (const node of call(path, event)) if (node instanceof Element && call(matches, node, clickable)) return node; return null; };
  const paying = (el) => {
    if (!el) return false;
    const text = plain(name(el));
    if (call(has, pay, text) || call(test, prefix, text)) return true;
    const submits = call(matches, el, 'button:not([type]), button[type=submit], input[type=submit], input[type=image]');
    return submits && posts(el.form);
  };
  const totalNear = (el) => {
    const pattern = /(order total|total due|amount due|total to pay|grand total|total|gesamtsumme|gesamt|summe|montant total|importe total|totale|totaal|合計|总计|합계)\\s*:?\\s*((?:[\\p{Sc}]|[A-Z]{3})\\s?\\d[\\d.,\\s]*\\d|\\d[\\d.,\\s]*\\d?\\s?(?:[\\p{Sc}]|[A-Z]{3}))/iu;
    for (let node = el, depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const found = (node.innerText || '').slice(0, 6000).match(pattern);
      if (found) return found[2].replace(/\\s+/g, ' ').trim();
    }
    return '';
  };
  let pending = null, allow = null, allowSecret = null;
  const hold = (event, el) => {
    if (allow && allow === el) return;
    call(prevent, event);
    call(stop, event);
    if (event.type !== 'click' && event.type !== 'submit' && event.type !== 'dblclick') return;
    if (pending) return;
    const secret = Array.from(random(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
    pending = { el, secret };
    report({ text: name(el).slice(0, 80) || 'a pay button', total: totalNear(el) }, secret).catch(() => { pending = null; });
  };
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'pointerup', 'mouseup', 'touchend', 'click', 'dblclick', 'auxclick'])
    addEventListener(type, (event) => { const el = target(event); if (paying(el)) hold(event, el); }, { capture: true, passive: false });
  addEventListener('submit', (event) => {
    const el = event.submitter || null;
    if (paying(el) || posts(event.target)) hold(event, el || event.target);
  }, true);
  // 'click': the daemon now clicks the marked element for real; 'done' clears the mark.
  const go = (secret, step) => {
    if (step === 'done') { if (allowSecret === secret && allow) { call(removeAttribute, allow, 'data-zoltbot-allow'); allow = null; allowSecret = null; } return true; }
    if (!pending || pending.secret !== secret) return false;
    const { el } = pending;
    pending = null;
    if (!step) return true;
    if (el instanceof HTMLFormElement) { allow = el; try { el.requestSubmit(); } finally { allow = null; } return 'done'; }
    allow = el;
    allowSecret = secret;
    call(setAttribute, el, 'data-zoltbot-allow', secret);
    return 'click';
  };
  Object.defineProperty(window, '__zoltbotPurchaseGo', { value: go });
})()`;
