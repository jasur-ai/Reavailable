/**
 * Update manifest published with every Android release (`update.json`). The app compares the
 * manifest's versionCode with the one it was installed with, and picks the APK for the CPU.
 *
 * Pure functions only: fetching and installing live in the platform layer.
 */

export interface ApkInfo {
  url: string;
  sha256: string;
}

export interface UpdateManifest {
  versionCode: number;
  versionName: string;
  tag: string;
  apks: Record<string, ApkInfo>;
}

export interface GitHubReleaseLike {
  tag_name: string;
  draft?: boolean;
  assets?: readonly { name: string; browser_download_url: string }[];
}

/** Preferred CPU architectures first. Older 32-bit phones use the second entry. */
export const PREFERRED_ABIS = ['arm64-v8a', 'armeabi-v7a'] as const;

const MANIFEST_ASSET = 'update.json';
const TAG_PREFIX = 'android-v';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validates the JSON of a manifest. Returns null for anything malformed. */
export function parseUpdateManifest(value: unknown): UpdateManifest | null {
  if (!isRecord(value)) {
    return null;
  }
  const { versionCode, versionName, tag, apks } = value;
  if (typeof versionCode !== 'number' || !Number.isInteger(versionCode) || versionCode < 1) {
    return null;
  }
  if (typeof versionName !== 'string' || typeof tag !== 'string' || !isRecord(apks)) {
    return null;
  }
  const parsed: Record<string, ApkInfo> = {};
  for (const [abi, entry] of Object.entries(apks)) {
    if (isRecord(entry) && typeof entry.url === 'string' && typeof entry.sha256 === 'string') {
      if (/^https:\/\/github\.com\//.test(entry.url)) {
        parsed[abi] = { url: entry.url, sha256: entry.sha256 };
      }
    }
  }
  if (Object.keys(parsed).length === 0) {
    return null;
  }
  return { versionCode, versionName, tag, apks: parsed };
}

/** True when the manifest describes a build newer than the installed one. */
export function isNewerThan(manifest: UpdateManifest, installedVersionCode: number): boolean {
  return manifest.versionCode > installedVersionCode;
}

/** The APK for the first supported architecture the device reports, or null when none fits. */
export function apkForDevice(
  manifest: UpdateManifest,
  deviceAbis: readonly string[],
): { abi: string; apk: ApkInfo } | null {
  for (const abi of PREFERRED_ABIS) {
    const apk = manifest.apks[abi];
    if (apk && deviceAbis.includes(abi)) {
      return { abi, apk };
    }
  }
  return null;
}

/**
 * URL of the newest `update.json` among the releases. Drafts and releases from other tags are
 * skipped. The releases list is newest first, as GitHub returns it.
 */
export function findManifestUrl(releases: readonly GitHubReleaseLike[]): string | null {
  for (const release of releases) {
    if (release.draft || !release.tag_name.startsWith(TAG_PREFIX)) {
      continue;
    }
    const asset = release.assets?.find((item) => item.name === MANIFEST_ASSET);
    if (asset) {
      return asset.browser_download_url;
    }
  }
  return null;
}
