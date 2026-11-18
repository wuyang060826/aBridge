import { deviceDetailsSchema, type DeviceDetails } from "@abridge/protocol";

export interface BrowserIdentity {
  userAgent?: string;
  userAgentData?: {
    brands: readonly { brand: string; version: string }[];
    getHighEntropyValues?(hints: string[]): Promise<{ platformVersion?: string }>;
  };
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

const brands = [
  ["Microsoft Edge", /\b(?:Edg|EdgA|EdgiOS)\/(\d+)/i],
  ["Opera", /\b(?:OPR|Opera)\/(\d+)/i],
  ["Vivaldi", /\bVivaldi\/(\d+)/i],
  ["Brave", /\bBrave\/(\d+)/i],
  ["Samsung Internet", /\bSamsungBrowser\/(\d+)/i],
  ["Google Chrome", /\b(?:Chrome|CriOS)\/(\d+)/i],
  ["Chromium", /\bChromium\/(\d+)/i],
] as const;

export async function collectBrowserDetails(
  runtime: typeof chrome.runtime,
  identity: BrowserIdentity,
  details: DeviceDetails,
): Promise<void> {
  const hints = identity.userAgentData?.brands ?? [];
  for (const [name, pattern] of brands) {
    const declared = hints.find(({ brand }) => brand === name);
    // Generic Chrome-compatible tokens are weaker evidence than the brand list.
    const generic = name === "Google Chrome" || name === "Chromium";
    const fallback = !generic || hints.length === 0 ? pattern.exec(identity.userAgent ?? "")?.[1] : undefined;
    const version = declared?.version.split(".")[0] ?? fallback;
    if (version && /^\d{1,8}$/.test(version)) {
      details.browser_name = name;
      details.browser_version = version;
      break;
    }
  }

  try {
    const platform = await runtime.getPlatformInfo?.();
    if (!platform) return;
    const os =
      platform.os === "mac"
        ? "macos"
        : platform.os === "win"
          ? "windows"
          : platform.os === "cros"
            ? "chromeos"
            : platform.os;
    const architecture =
      platform.arch === "x86-64" ? "x86_64" : platform.arch === "x86-32" ? "x86" : platform.arch;
    const reportedOs = deviceDetailsSchema.shape.os.safeParse(os);
    const reportedArch = deviceDetailsSchema.shape.architecture.safeParse(architecture);
    if (reportedOs.success && reportedOs.data) details.os = reportedOs.data;
    if (reportedArch.success && reportedArch.data) details.architecture = reportedArch.data;
    // Windows platformVersion is a platform-contract version. Linux often lacks a release version.
    if (details.os === "macos" || details.os === "android") {
      const version = (await identity.userAgentData?.getHighEntropyValues?.(["platformVersion"]))
        ?.platformVersion;
      if (version && /^[1-9]\d{0,3}(\.\d{1,4}){0,2}$/.test(version)) details.os_version = version;
    }
  } catch {
    // Platform metadata is best effort and independent of browser authorization.
  }
}
