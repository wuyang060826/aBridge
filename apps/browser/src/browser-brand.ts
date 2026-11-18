export interface BrowserIdentity {
  userAgent?: string;
  userAgentData?: { brands: readonly { brand: string; version: string }[] };
}

/** Use the browser's declared brand, including derivatives that identify themselves as Chrome. */
export function browserPlatform(identity: BrowserIdentity): string {
  const brands = identity.userAgentData?.brands.map(({ brand }) => brand.toLowerCase());
  const ua = identity.userAgent ?? "";
  // Chromium tokens also occur in other browsers; prefer explicit client-hint brands.
  if (/\b(?:Edg|EdgA|EdgiOS|OPR|Opera|Vivaldi|SamsungBrowser)\//i.test(ua)) return "Browser extension";
  if (brands?.length) return brands.includes("google chrome") ? "chrome" : "Browser extension";
  return /\bChrome\//.test(ua) ? "chrome" : "Browser extension";
}
