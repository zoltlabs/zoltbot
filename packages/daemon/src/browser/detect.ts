// B4: spots pages where the agent should stop and ask the owner. Runs inside the page.
export interface PageNeeds {
  password: boolean;
  verification: boolean;
  payment: boolean;
}

/** Checks only what's visible; hidden decoy fields don't count. */
export const DETECT_SCRIPT = `(() => {
  const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const any = (selector) => [...document.querySelectorAll(selector)].some(shown);
  const frames = [...document.querySelectorAll('iframe')].filter(shown).map((f) => f.src || '');
  return {
    password: any('input[type=password]'),
    verification: frames.some((src) => /recaptcha|hcaptcha|challenges\\.cloudflare\\.com|turnstile|arkoselabs|funcaptcha|geetest/i.test(src)) || any('.g-recaptcha,.h-captcha,.cf-turnstile,[data-sitekey]'),
    payment: any('input[autocomplete^="cc-"],input[name*="cardnumber" i],input[name*="card_number" i],input[id*="cardnumber" i]') || frames.some((src) => /js\\.stripe\\.com|checkout\\.|braintree|adyen|paypal\\.com\\/sdk/i.test(src)),
  };
})()`;

/** What the agent hears, at most once per kind and site. */
export const NUDGES: Record<keyof PageNeeds, string> = {
  password:
    "This page asks for a password. Don't type one: run your browser command with need-human sign_in 'why' and wait.",
  verification:
    "This page shows a human check. Don't try to solve it: run your browser command with need-human verification 'why' and wait.",
  payment:
    "This page asks for payment details. Don't enter any: run your browser command with need-human payment 'why' and wait.",
};
