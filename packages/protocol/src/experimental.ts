export const experimentalProviderNotice = Object.freeze({
  id: "experimental-providers-v2",
  title: "Review experimental providers",
  message:
    "Experimental providers use official CLI interfaces, but some capabilities have limited real-world verification. Check the selected CLI version and sign-in in Doctor before connecting. Zoltbot does not impersonate other clients.",
});
export function experimentalProvidersEnabled(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const preference = value as Record<string, unknown>;
  return preference.enabled === true && preference.noticeVersion === experimentalProviderNotice.id;
}
