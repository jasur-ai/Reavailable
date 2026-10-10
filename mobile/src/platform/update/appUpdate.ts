/**
 * In-app updates for the Android build. The app looks up the newest release that carries an
 * `update.json` manifest, downloads the APK for the device's CPU, and hands it to Android's
 * package installer. Android shows its own confirmation, so the user always decides.
 *
 * Installing over an existing copy keeps the app's data, because the signing key is the same.
 */

import * as Application from 'expo-application';
import * as Device from 'expo-device';
import { Directory, File, Paths } from 'expo-file-system';
import { getContentUriAsync } from 'expo-file-system/legacy';
import * as IntentLauncher from 'expo-intent-launcher';
import { Platform } from 'react-native';
import {
  apkForDevice,
  findManifestUrl,
  isNewerThan,
  parseUpdateManifest,
  type GitHubReleaseLike,
  type UpdateManifest,
} from '../../core/update/manifest';

export const RELEASES_URL = 'https://api.github.com/repos/jasur-ai/Reavailable/releases?per_page=10';

/** Android's flag that lets the installer read the downloaded file. */
const FLAG_GRANT_READ_URI_PERMISSION = 1;
const FLAG_ACTIVITY_NEW_TASK = 0x10000000;

export interface InstalledVersion {
  versionName: string;
  versionCode: number;
}

export function installedVersion(): InstalledVersion {
  return {
    versionName: Application.nativeApplicationVersion ?? '0',
    versionCode: Number(Application.nativeBuildVersion ?? '0') || 0,
  };
}

export function updatesSupported(): boolean {
  return Platform.OS === 'android';
}

/** The newest manifest that is newer than the installed build, or null when up to date. */
export async function checkForUpdate(): Promise<UpdateManifest | null> {
  if (!updatesSupported()) {
    return null;
  }
  const releasesResponse = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' } });
  if (!releasesResponse.ok) {
    throw new Error(`GitHub answered ${releasesResponse.status}`);
  }
  const releases = (await releasesResponse.json()) as GitHubReleaseLike[];
  const manifestUrl = findManifestUrl(releases);
  if (!manifestUrl) {
    return null;
  }
  const manifestResponse = await fetch(manifestUrl);
  if (!manifestResponse.ok) {
    throw new Error(`The update manifest could not be read (${manifestResponse.status}).`);
  }
  const manifest = parseUpdateManifest(await manifestResponse.json());
  if (!manifest) {
    throw new Error('The update manifest is not valid.');
  }
  return isNewerThan(manifest, installedVersion().versionCode) ? manifest : null;
}

/**
 * Downloads the APK for this device and opens the system installer. Throws with a short reason
 * when no APK fits the device or the download fails.
 */
export async function installUpdate(manifest: UpdateManifest): Promise<void> {
  const choice = apkForDevice(manifest, Device.supportedCpuArchitectures ?? []);
  if (!choice) {
    throw new Error('no-apk');
  }
  const folder = new Directory(Paths.cache, 'updates');
  folder.create({ idempotent: true, intermediates: true });
  const file = await File.downloadFileAsync(choice.apk.url, folder);
  const contentUri = await getContentUriAsync(file.uri);
  await IntentLauncher.startActivityAsync('android.intent.action.VIEW', {
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK,
  });
}
