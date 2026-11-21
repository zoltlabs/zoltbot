// B5: answers cookie banners so the agent doesn't spend turns on them. Reject by default; the
// owner lists sites where the browser accepts instead.
import { randomUUID } from "node:crypto";
import type { DomainEvent } from "@zoltbot/protocol";
import type { Store } from "@zoltbot/store";

/** Setting: hosts where the agent's browser accepts cookies. A host covers its subdomains. */
export const COOKIE_ACCEPT_SETTING = "browser.cookies.accept";
const MAX_SITES = 200;

export type ConsentChoice = "reject" | "accept" | "skip";

/** Normalizes the owner's list; throws on anything that isn't a list of host names. */
export function parseCookieSites(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_SITES) throw Error("invalid_cookie_sites");
  const sites = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") throw Error("invalid_cookie_sites");
    const host = entry
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/[/:].*$/, "")
      .replace(/\.$/, "")
      .replace(/^www\./, "");
    // At least two labels, so a bare `com` can't cover every site under it.
    if (
      !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(
        host,
      )
    )
      throw Error("invalid_cookie_sites");
    sites.add(host);
  }
  return [...sites].sort();
}

/** The site a list entry names: the host without `www.`. */
export function siteOf(url: string) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

const covers = (site: string, host: string) => host === site || host.endsWith(`.${site}`);

/** Accept only where the page's site, or a parent of it, is listed. */
export function consentChoice(pageUrl: string, accepted: readonly string[]): "reject" | "accept" {
  const host = siteOf(pageUrl);
  return host && accepted.some((site) => covers(site, host)) ? "accept" : "reject";
}

// Known consent tools' own buttons, as [reject, accept] selectors. Checked before any text match.
const KNOWN: [string, string][] = [
  ["#onetrust-reject-all-handler", "#onetrust-accept-btn-handler"],
  [
    "#CybotCookiebotDialogBodyButtonDecline",
    "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll",
  ],
  ["#didomi-notice-disagree-button", "#didomi-notice-agree-button"],
  ["#truste-consent-required", "#truste-consent-button"],
  ['[data-testid="uc-deny-all-button"]', '[data-testid="uc-accept-all-button"]'],
  [".sp_choice_type_13", ".sp_choice_type_11"],
  [".fc-cta-do-not-consent", ".fc-cta-consent"],
  [".cky-btn-reject", ".cky-btn-accept"],
  [".cmplz-deny", ".cmplz-accept"],
  [".osano-cm-denyAll", ".osano-cm-accept-all"],
  [".iubenda-cs-reject-btn", ".iubenda-cs-accept-btn"],
  ['[data-tid="banner-decline"]', '[data-tid="banner-accept"]'],
  [".cm-btn-decline", ".cm-btn-accept-all"],
];

// Whole button names only, so "Reject this request" never matches.
const REJECT = [
  "reject all",
  "reject",
  "reject all cookies",
  "reject cookies",
  "decline",
  "decline all",
  "deny",
  "deny all",
  "only necessary",
  "necessary only",
  "only necessary cookies",
  "use necessary cookies only",
  "only essential",
  "essential only",
  "only essential cookies",
  "refuse",
  "refuse all",
  "do not consent",
  "disagree",
  "alle ablehnen",
  "ablehnen",
  "nur notwendige",
  "nur notwendige cookies",
  "nur erforderliche",
  "tout refuser",
  "refuser",
  "refuser tout",
  "continuer sans accepter",
  "rechazar todo",
  "rechazar todas",
  "rechazar",
  "solo necesarias",
  "rifiuta tutto",
  "rifiuta",
  "solo necessari",
  "alles weigeren",
  "weigeren",
  "alleen noodzakelijk",
  "rejeitar tudo",
  "rejeitar todos",
  "rejeitar",
  "recusar",
  "odrzuć wszystkie",
  "odrzuć",
  "avvisa alla",
  "afvis alle",
  "hylkää kaikki",
  "すべて拒否",
  "拒否",
  "拒绝",
  "全部拒绝",
  "모두 거부",
  "거부",
];
const ACCEPT = [
  "accept all",
  "accept",
  "accept all cookies",
  "accept cookies",
  "allow all",
  "allow all cookies",
  "allow cookies",
  "agree",
  "i agree",
  "i accept",
  "agree and close",
  "got it",
  "alle akzeptieren",
  "akzeptieren",
  "zustimmen",
  "alle zulassen",
  "tout accepter",
  "accepter",
  "accepter et fermer",
  "j'accepte",
  "aceptar todo",
  "aceptar todas",
  "aceptar",
  "accetta tutto",
  "accetta",
  "alles accepteren",
  "accepteren",
  "aceitar tudo",
  "aceitar todos",
  "aceitar",
  "zaakceptuj wszystkie",
  "acceptera alla",
  "accepter alle",
  "hyväksy kaikki",
  "すべて同意",
  "同意する",
  "全部接受",
  "接受",
  "모두 동의",
  "동의",
];

/**
 * Runs in every frame from the first script on. Watches for a banner for 15 seconds after load and
 * asks the daemon what to do once; the daemon answers from the top page's site.
 */
// Consent tools that serve their banner from a frame on their own domain.
const FRAME_HOSTS = [
  "privacy-mgmt.com",
  "sp-prod.net",
  "cookiebot.com",
  "consensu.org",
  "cookielaw.org",
  "onetrust.com",
  "trustarc.com",
  "truste.com",
  "usercentrics.eu",
  "didomi.io",
  "quantcast.com",
];

/**
 * Runs in every frame from the first script on. Watches for a banner for 15 seconds after load and
 * asks the daemon before each click; the daemon answers from the top page's site.
 */
export const CONSENT_SCRIPT = `(() => {
  if (window.__zoltbotConsentSeen) return;
  window.__zoltbotConsentSeen = true;
  const ask = window.__zoltbotConsent;
  if (typeof ask !== 'function') return;
  const known = ${JSON.stringify(KNOWN)};
  const words = { reject: new Set(${JSON.stringify(REJECT)}), accept: new Set(${JSON.stringify(ACCEPT)}) };
  const area = /cookie|consent|gdpr|\\bcmp\\b|cmp[-_]|privacy[-_ ]?(banner|notice|center)|onetrust|didomi|usercentrics|sp_message|qc-cmp|truste/i;
  // The banner itself must talk about cookies, so sign-in or terms "consent" screens never match.
  const about = /cookie|ciasteczk|クッキー|쿠키|tracker/i;
  const frameHosts = ${JSON.stringify(FRAME_HOSTS)};
  const toolFrame = window !== window.top && frameHosts.some((h) => location.hostname === h || location.hostname.endsWith('.' + h));
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled; };
  const name = (el) => (el.getAttribute('aria-label') || el.innerText || el.value || '').replace(/\\s+/g, ' ').trim().toLowerCase().replace(/[.!]$/, '');
  const inBanner = (el) => {
    if (toolFrame) return true;
    for (let node = el, depth = 0; node && depth < 12; depth++) {
      if (node instanceof Element) {
        if (node === document.body || node === document.documentElement) return false;
        const label = (node.id || '') + ' ' + (typeof node.className === 'string' ? node.className : '') + ' ' + (node.getAttribute('aria-label') || '');
        const boxed = area.test(label) || /fixed|sticky/.test(getComputedStyle(node).position) || node.getAttribute('role') === 'dialog' || node.getAttribute('aria-modal') === 'true';
        if (boxed) { const text = node.innerText || ''; if (about.test(text) && text.length < 4000) return true; }
      }
      node = node.parentNode || node.host;
    }
    return false;
  };
  const find = (choice) => {
    const roots = [document];
    for (let i = 0; i < roots.length && i < 50; i++) for (const el of roots[i].querySelectorAll('*')) if (el.shadowRoot) roots.push(el.shadowRoot);
    const all = (selector) => roots.flatMap((root) => [...root.querySelectorAll(selector)]);
    const pick = (c) => {
      for (const pair of known) for (const el of all(pair[c === 'reject' ? 0 : 1])) if (shown(el)) return el;
      for (const el of all('button, [role=button], a, input[type=button], input[type=submit]'))
        if (words[c].has(name(el)) && shown(el) && inBanner(el)) return el;
      return null;
    };
    return choice ? pick(choice) : pick('reject') || pick('accept');
  };
  let clicks = 0, timer = 0, until = 0, busy = false;
  const observer = new MutationObserver(() => later());
  const check = async () => {
    timer = 0;
    if (clicks >= 2 || Date.now() > until) return observer.disconnect();
    if (busy || !find()) return;
    busy = true;
    try {
      // Asked before every click: the answer is 'skip' while the owner has the browser.
      let choice;
      try { choice = await ask(); } catch { return; }
      if (choice !== 'reject' && choice !== 'accept') return;
      const button = find(choice);
      if (!button) return;
      clicks++;
      button.click();
    } finally { busy = false; }
  };
  const later = () => { if (!timer) timer = setTimeout(check, 250); };
  const start = () => {
    until = Date.now() + 15000;
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
    later();
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', start, { once: true }); else start();
})()`;

/** The owner's list, read from settings, and the one way to change it. */
export function cookieSettings(store: Store, publish?: (events: DomainEvent[]) => void) {
  const sites = () => {
    const row = store.snapshot(["settings"]).settings?.find((r) => r.key === COOKIE_ACCEPT_SETTING);
    try {
      return parseCookieSites(row?.value ?? []);
    } catch {
      return [];
    }
  };
  return {
    sites,
    /** Accepts or rejects banners on a site from now on; returns the new list. */
    set(site: unknown, accept: boolean) {
      const [host] = parseCookieSites([site]);
      if (!host) throw Error("invalid_cookie_sites");
      // Rejecting removes whichever listed site covered this one, so the choice takes effect.
      const current = sites().filter((s) => (accept ? s !== host : !covers(s, host)));
      const value = parseCookieSites(accept ? [...current, host] : current);
      const commandId = `browser-cookies:${randomUUID()}`;
      const before = store.lastSeq();
      store.dispatch(commandId, () => ({
        events: [
          {
            eventId: `${commandId}:0`,
            aggregateType: "settings",
            aggregateId: COOKIE_ACCEPT_SETTING,
            type: "settings.created",
            occurredAt: new Date().toISOString(),
            payload: { key: COOKIE_ACCEPT_SETTING, value },
          },
        ],
        result: { ok: true },
      }));
      publish?.(store.eventsSince(before));
      return { site: host, accept, sites: value };
    },
  };
}
