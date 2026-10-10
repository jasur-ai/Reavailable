import {
  apkForDevice,
  findManifestUrl,
  isNewerThan,
  parseUpdateManifest,
} from '../../src/core/update/manifest';

const URL64 = 'https://github.com/jasur-ai/Reavailable/releases/download/android-v0.2.3/app-arm64-v8a-release.apk';
const URL32 = 'https://github.com/jasur-ai/Reavailable/releases/download/android-v0.2.3/app-armeabi-v7a-release.apk';

const valid = {
  versionCode: 4,
  versionName: '0.2.3',
  tag: 'android-v0.2.3',
  apks: {
    'arm64-v8a': { url: URL64, sha256: 'a'.repeat(64) },
    'armeabi-v7a': { url: URL32, sha256: 'b'.repeat(64) },
  },
};

describe('parseUpdateManifest', () => {
  it('accepts a complete manifest', () => {
    expect(parseUpdateManifest(valid)?.versionCode).toBe(4);
  });

  it('rejects a missing or non-integer version code', () => {
    expect(parseUpdateManifest({ ...valid, versionCode: undefined })).toBeNull();
    expect(parseUpdateManifest({ ...valid, versionCode: 3.5 })).toBeNull();
    expect(parseUpdateManifest({ ...valid, versionCode: 0 })).toBeNull();
  });

  it('drops APK links that do not point to GitHub', () => {
    const manifest = parseUpdateManifest({
      ...valid,
      apks: { 'arm64-v8a': { url: 'https://evil.example/app.apk', sha256: 'x' } },
    });
    expect(manifest).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(parseUpdateManifest(null)).toBeNull();
    expect(parseUpdateManifest('update')).toBeNull();
  });
});

describe('isNewerThan', () => {
  it('is true only for a higher version code', () => {
    const manifest = parseUpdateManifest(valid)!;
    expect(isNewerThan(manifest, 3)).toBe(true);
    expect(isNewerThan(manifest, 4)).toBe(false);
    expect(isNewerThan(manifest, 5)).toBe(false);
  });
});

describe('apkForDevice', () => {
  it('prefers 64-bit and falls back to 32-bit', () => {
    const manifest = parseUpdateManifest(valid)!;
    expect(apkForDevice(manifest, ['arm64-v8a', 'armeabi-v7a'])?.abi).toBe('arm64-v8a');
    expect(apkForDevice(manifest, ['armeabi-v7a'])?.abi).toBe('armeabi-v7a');
    expect(apkForDevice(manifest, ['x86_64'])).toBeNull();
  });
});

describe('findManifestUrl', () => {
  it('returns the manifest of the newest android release, skipping drafts', () => {
    const releases = [
      { tag_name: 'web-v1', assets: [{ name: 'update.json', browser_download_url: 'https://x/web' }] },
      {
        tag_name: 'android-v0.2.4',
        draft: true,
        assets: [{ name: 'update.json', browser_download_url: 'https://x/draft' }],
      },
      {
        tag_name: 'android-v0.2.3',
        assets: [{ name: 'update.json', browser_download_url: 'https://x/0.2.3' }],
      },
    ];
    expect(findManifestUrl(releases)).toBe('https://x/0.2.3');
  });

  it('returns null when no release carries a manifest', () => {
    expect(findManifestUrl([{ tag_name: 'android-v0.2.1-cf2', assets: [] }])).toBeNull();
  });
});
