import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const plist = require('@expo/plist').default as {
  parse: (source: string) => Record<string, any>;
};
const { PNG } = require('pngjs') as {
  PNG: {
    sync: {
      read: (source: Buffer) => {
        width: number;
        height: number;
        colorType: number;
        data: Buffer;
      };
    };
  };
};

const ROOT = path.resolve(__dirname, '..');
const APP_JSON_PATH = path.join(ROOT, 'app.json');
const INFO_PLIST_PATH = path.join(ROOT, 'ios/app/Info.plist');
const PRIVACY_MANIFEST_PATH = path.join(ROOT, 'ios/app/PrivacyInfo.xcprivacy');
const PBXPROJ_PATH = path.join(ROOT, 'ios/app.xcodeproj/project.pbxproj');
const ENTITLEMENTS_PATH = path.join(ROOT, 'ios/app/app.entitlements');
const APP_ICON_PATH = path.join(ROOT, 'assets/images/icon.png');
const NOTIFICATION_ICON_PATH = path.join(ROOT, 'assets/images/notification-icon.png');
const IOS_APP_ICON_PATH = path.join(
  ROOT,
  'ios/app/Images.xcassets/AppIcon.appiconset/AppIcon-1024.png',
);
const VERIFIER_PATH = path.join(ROOT, 'scripts/verify-release-config.mjs');
const VERIFY_WORKFLOW_PATH = path.join(ROOT, '.github/workflows/verify.yml');

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

function readPlist(filePath: string) {
  return plist.parse(fs.readFileSync(filePath, 'utf8'));
}

function readPng(filePath: string) {
  return PNG.sync.read(fs.readFileSync(filePath));
}

function findPlugin(expo: Record<string, any>, name: string): Record<string, any> | undefined {
  const entry = (expo.plugins as unknown[]).find(
    (plugin) => Array.isArray(plugin) && plugin[0] === name,
  );
  return Array.isArray(entry) ? (entry[1] as Record<string, any>) : undefined;
}

function collectFiles(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];

  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? collectFiles(entryPath) : [entryPath];
  });
}

function createVerifierFixture(): string {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'recoto-release-'));
  const fixtureFiles = [
    'app.json',
    '.env.example',
    'ios/app/Info.plist',
    'ios/app/PrivacyInfo.xcprivacy',
    'ios/app/en.lproj/InfoPlist.strings',
    'ios/app/ja.lproj/InfoPlist.strings',
    'ios/app.xcodeproj/project.pbxproj',
    'ios/app/Images.xcassets/AppIcon.appiconset/AppIcon-1024.png',
    'ios/app/Images.xcassets/AppIcon.appiconset/Contents.json',
    'assets/images/icon.png',
    'assets/images/notification-icon.png',
    'locales/en.json',
    'locales/ja.json',
  ];

  for (const relativePath of fixtureFiles) {
    const destination = path.join(fixtureRoot, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relativePath), destination);
  }

  return fixtureRoot;
}

describe('Recoto release identity', () => {
  test('uses the exact Expo name, scheme, and bundle identifiers', () => {
    const { expo } = readJson<{ expo: Record<string, any> }>(APP_JSON_PATH);

    expect(expo.name).toBe('レコト');
    expect(expo.slug).toBe('recoto');
    expect(expo.scheme).toBe('recoto');
    expect(expo.ios.bundleIdentifier).toBe('com.herac.recoto');
    expect(expo.android.package).toBe('com.herac.recoto');
    expect(expo.ios.usesAppleSignIn).toBe(true);
    expect(expo.ios.infoPlist?.CFBundleAllowMixedLocalizations).toBe(true);
    expect(expo.plugins).toContain('expo-apple-authentication');
  });

  test('configures distinct release and notification artwork plus a concrete photo purpose', () => {
    const { expo } = readJson<{ expo: Record<string, any> }>(APP_JSON_PATH);
    const notifications = findPlugin(expo, 'expo-notifications');
    const imagePicker = findPlugin(expo, 'expo-image-picker');

    expect(expo.icon).toBe('./assets/images/icon.png');
    expect(expo.splash?.image).toBe('./assets/images/icon.png');
    expect(notifications?.icon).toBe('./assets/images/notification-icon.png');
    expect(notifications?.icon).not.toBe(expo.icon);
    expect(imagePicker).toEqual({
      photosPermission:
        '予定・日記・グループ・画像スタンプに、あなたが選んだ写真を表示するために使用します。',
      cameraPermission: false,
      microphonePermission: false,
    });
  });

  test('keeps native iOS identity aligned without renaming the app target', () => {
    const info = readPlist(INFO_PLIST_PATH);
    const pbxproj = fs.readFileSync(PBXPROJ_PATH, 'utf8');
    const bundleIdentifiers = [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map(
      (match) => match[1],
    );

    expect(info.CFBundleDisplayName).toBe('レコト');
    expect(info.CFBundleName).toBe('レコト');
    expect(info.CFBundleAllowMixedLocalizations).toBe(true);
    expect(info.CFBundleURLTypes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ CFBundleURLSchemes: expect.arrayContaining(['recoto']) }),
      ]),
    );
    expect(info.NSPhotoLibraryUsageDescription).toBe(
      '予定・日記・グループ・画像スタンプに、あなたが選んだ写真を表示するために使用します。',
    );
    expect(bundleIdentifiers).toEqual(['com.herac.recoto', 'com.herac.recoto']);
    expect(pbxproj).not.toContain('org.name.app');
    expect(pbxproj).toContain('Build configuration list for PBXNativeTarget "app"');
    expect(fs.existsSync(ENTITLEMENTS_PATH)).toBe(true);
    const entitlements = readPlist(ENTITLEMENTS_PATH);
    expect(entitlements['com.apple.developer.applesignin']).toEqual(['Default']);
    expect(pbxproj.match(/CODE_SIGN_ENTITLEMENTS = app\/app\.entitlements;/g)).toHaveLength(2);
    expect(pbxproj).toContain('SystemCapabilities');
    expect(pbxproj).toContain('com.apple.SignInWithApple');
    expect(pbxproj).toContain('InfoPlist.strings in Resources');
    expect(pbxproj).toContain('app/en.lproj/InfoPlist.strings');
    expect(pbxproj).toContain('app/ja.lproj/InfoPlist.strings');
  });

  test('contains no obsolete scheduleshare deep link outside the preserved token namespace', () => {
    const sourceDirectories = ['app', 'components', 'hooks', 'lib', 'store', 'utils'];
    const operationalFiles = sourceDirectories
      .flatMap((directory) => collectFiles(path.join(ROOT, directory)))
      .filter((filePath) => /\.(?:ts|tsx|js|jsx|json|md)$/.test(filePath))
      .filter((filePath) => filePath !== path.join(ROOT, 'store/googleAuthStore.ts'))
      .concat([
        APP_JSON_PATH,
        path.join(ROOT, '.env.example'),
        path.join(ROOT, 'DEPLOY_CHECKLIST.md'),
      ]);
    const obsoleteScheme = ['schedule', 'share'].join('');
    const offenders = operationalFiles
      .filter((filePath) => new RegExp(`${obsoleteScheme}(?::\\/\\/|\\b)`).test(fs.readFileSync(filePath, 'utf8')))
      .map((filePath) => path.relative(ROOT, filePath));

    expect(offenders).toEqual([]);
    expect(fs.readFileSync(path.join(ROOT, 'store/googleAuthStore.ts'), 'utf8')).toContain(
      '@scheduleshare/secure/',
    );
  });
});

describe('release artwork', () => {
  test('installs square, opaque 1024px app icons and names the iOS asset', () => {
    expect(fs.existsSync(APP_ICON_PATH)).toBe(true);
    expect(fs.existsSync(IOS_APP_ICON_PATH)).toBe(true);
    if (!fs.existsSync(APP_ICON_PATH) || !fs.existsSync(IOS_APP_ICON_PATH)) return;

    for (const iconPath of [APP_ICON_PATH, IOS_APP_ICON_PATH]) {
      const icon = readPng(iconPath);
      expect({ width: icon.width, height: icon.height, colorType: icon.colorType }).toEqual({
        width: 1024,
        height: 1024,
        colorType: 2,
      });
    }

    const contents = readJson<{ images: Array<{ filename?: string }> }>(
      path.join(ROOT, 'ios/app/Images.xcassets/AppIcon.appiconset/Contents.json'),
    );
    expect(contents.images).toEqual(
      expect.arrayContaining([expect.objectContaining({ filename: 'AppIcon-1024.png' })]),
    );
  });

  test('uses a transparent 96px white Android notification glyph', () => {
    expect(fs.existsSync(NOTIFICATION_ICON_PATH)).toBe(true);
    if (!fs.existsSync(NOTIFICATION_ICON_PATH)) return;

    const icon = readPng(NOTIFICATION_ICON_PATH);
    let transparentPixels = 0;
    let visiblePixels = 0;
    let nonWhiteVisiblePixels = 0;

    for (let offset = 0; offset < icon.data.length; offset += 4) {
      const red = icon.data[offset];
      const green = icon.data[offset + 1];
      const blue = icon.data[offset + 2];
      const alpha = icon.data[offset + 3];
      if (alpha === 0) {
        transparentPixels += 1;
      } else {
        visiblePixels += 1;
        if (red !== 255 || green !== 255 || blue !== 255) nonWhiteVisiblePixels += 1;
      }
    }

    expect({ width: icon.width, height: icon.height, colorType: icon.colorType }).toEqual({
      width: 96,
      height: 96,
      colorType: 6,
    });
    expect(transparentPixels).toBeGreaterThan(0);
    expect(visiblePixels).toBeGreaterThan(0);
    expect(nonWhiteVisiblePixels).toBe(0);
  });
});

describe('app-owned privacy manifest', () => {
  test('declares only current linked app-functionality data with no tracking', () => {
    expect(fs.existsSync(PRIVACY_MANIFEST_PATH)).toBe(true);
    if (!fs.existsSync(PRIVACY_MANIFEST_PATH)) return;

    const manifest = readPlist(PRIVACY_MANIFEST_PATH);
    const collectedData = manifest.NSPrivacyCollectedDataTypes as Array<Record<string, any>>;
    const collectedTypes = collectedData.map((entry) => entry.NSPrivacyCollectedDataType).sort();

    expect(manifest.NSPrivacyTracking).toBe(false);
    expect(manifest.NSPrivacyTrackingDomains).toEqual([]);
    expect(collectedTypes).toEqual(
      [
        'NSPrivacyCollectedDataTypeEmailAddress',
        'NSPrivacyCollectedDataTypeName',
        'NSPrivacyCollectedDataTypeOtherUserContent',
        'NSPrivacyCollectedDataTypePhotosorVideos',
        'NSPrivacyCollectedDataTypeUserID',
      ].sort(),
    );
    for (const entry of collectedData) {
      expect(entry.NSPrivacyCollectedDataTypeLinked).toBe(true);
      expect(entry.NSPrivacyCollectedDataTypeTracking).toBe(false);
      expect(entry.NSPrivacyCollectedDataTypePurposes).toEqual([
        'NSPrivacyCollectedDataTypePurposeAppFunctionality',
      ]);
    }
  });

  test('declares approved file timestamp and user defaults reasons', () => {
    expect(fs.existsSync(PRIVACY_MANIFEST_PATH)).toBe(true);
    if (!fs.existsSync(PRIVACY_MANIFEST_PATH)) return;

    const manifest = readPlist(PRIVACY_MANIFEST_PATH);
    const accessedApis = manifest.NSPrivacyAccessedAPITypes as Array<Record<string, any>>;
    const reasons = Object.fromEntries(
      accessedApis.map((entry) => [
        entry.NSPrivacyAccessedAPIType,
        entry.NSPrivacyAccessedAPITypeReasons,
      ]),
    );

    expect(reasons).toEqual({
      NSPrivacyAccessedAPICategoryFileTimestamp: ['C617.1'],
      NSPrivacyAccessedAPICategoryUserDefaults: ['CA92.1'],
    });
  });

  test('adds PrivacyInfo.xcprivacy to the app group and target resources', () => {
    const pbxproj = fs.readFileSync(PBXPROJ_PATH, 'utf8');

    expect(pbxproj).toMatch(/PrivacyInfo\.xcprivacy in Resources.*fileRef.*PrivacyInfo\.xcprivacy/);
    expect(pbxproj).toMatch(/lastKnownFileType = text\.xml;.*path = app\/PrivacyInfo\.xcprivacy/);
    expect(pbxproj).toMatch(/children = \([\s\S]*PrivacyInfo\.xcprivacy[\s\S]*\);\s*name = app;/);
    expect(pbxproj).toMatch(/PBXResourcesBuildPhase[\s\S]*files = \([\s\S]*PrivacyInfo\.xcprivacy in Resources/);
  });
});

describe('release configuration verifier', () => {
  test('requires the real legal site URL in production CI', () => {
    const workflow = fs.readFileSync(VERIFY_WORKFLOW_PATH, 'utf8');

    expect(workflow).toContain('NODE_ENV: production');
    expect(workflow).toContain(
      'EXPO_PUBLIC_LEGAL_BASE_URL: ${{ secrets.EXPO_PUBLIC_LEGAL_BASE_URL }}',
    );
    expect(workflow).toContain('npm run verify:config');
  });

  test('accepts the checked-in production configuration', () => {
    const result = spawnSync(process.execPath, [VERIFIER_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        EXPO_PUBLIC_LEGAL_BASE_URL: 'https://legal.recoto.app',
      },
    });

    expect(result.status).toBe(0);
  });

  test('rejects dangerous EXPO_PUBLIC names without printing their values', () => {
    const sensitiveValue = 'never-print-this-private-value';
    const result = spawnSync(process.execPath, [VERIFIER_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        EXPO_PUBLIC_CLIENT_PRIVATE_KEY: sensitiveValue,
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('EXPO_PUBLIC_CLIENT_PRIVATE_KEY');
    expect(output).not.toContain(sensitiveValue);
  });

  test('rejects an insecure production legal URL', () => {
    const fixtureRoot = createVerifierFixture();
    try {
      const config = readJson<{ expo: Record<string, any> }>(APP_JSON_PATH);
      config.expo.extra = {
        ...config.expo.extra,
        privacyPolicyUrl: 'http://example.com/privacy',
      };
      fs.writeFileSync(path.join(fixtureRoot, 'app.json'), `${JSON.stringify(config, null, 2)}\n`);

      const result = spawnSync(process.execPath, [VERIFIER_PATH], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toMatch(/legal URL|HTTPS/i);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('rejects dangerous names declared in environment files without printing values', () => {
    const fixtureRoot = createVerifierFixture();
    const sensitiveValue = 'never-print-this-service-role-value';
    try {
      fs.writeFileSync(
        path.join(fixtureRoot, '.env.production'),
        `EXPO_PUBLIC_SUPABASE_SERVICE_ROLE=${sensitiveValue}\n`,
      );
      const result = spawnSync(process.execPath, [VERIFIER_PATH], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).not.toBe(0);
      expect(output).toContain('EXPO_PUBLIC_SUPABASE_SERVICE_ROLE');
      expect(output).not.toContain(sensitiveValue);
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('rejects existing files assigned to the wrong Expo release asset fields', () => {
    const fixtureRoot = createVerifierFixture();
    try {
      const config = readJson<{ expo: Record<string, any> }>(APP_JSON_PATH);
      const notifications = findPlugin(config.expo, 'expo-notifications');
      if (!notifications) throw new Error('expo-notifications plugin is required by this fixture');

      config.expo.icon = './assets/images/notification-icon.png';
      config.expo.splash.image = './assets/images/notification-icon.png';
      notifications.icon = './assets/images/icon.png';
      fs.writeFileSync(path.join(fixtureRoot, 'app.json'), `${JSON.stringify(config, null, 2)}\n`);

      const result = spawnSync(process.execPath, [VERIFIER_PATH], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
      });
      const output = `${result.stdout}${result.stderr}`;

      expect(result.status).not.toBe(0);
      expect(output).toContain('expo.icon');
      expect(output).toContain('expo.splash.image');
      expect(output).toContain('expo-notifications icon');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('rejects an alternate iOS AppIcon filename even when that file exists', () => {
    const fixtureRoot = createVerifierFixture();
    try {
      const contentsPath = path.join(
        fixtureRoot,
        'ios/app/Images.xcassets/AppIcon.appiconset/Contents.json',
      );
      const contents = readJson<{ images: Array<{ filename?: string }> }>(contentsPath);
      contents.images[0].filename = 'Alternate-1024.png';
      fs.writeFileSync(contentsPath, `${JSON.stringify(contents, null, 2)}\n`);
      fs.copyFileSync(
        path.join(fixtureRoot, 'ios/app/Images.xcassets/AppIcon.appiconset/AppIcon-1024.png'),
        path.join(fixtureRoot, 'ios/app/Images.xcassets/AppIcon.appiconset/Alternate-1024.png'),
      );

      const result = spawnSync(process.execPath, [VERIFIER_PATH], {
        cwd: fixtureRoot,
        encoding: 'utf8',
        env: { ...process.env, NODE_ENV: 'production' },
      });

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain('AppIcon-1024.png');
    } finally {
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test('rejects an insecure production public legal URL without printing its value', () => {
    const insecureUrl = 'http://example.com/legal';
    const result = spawnSync(process.execPath, [VERIFIER_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        EXPO_PUBLIC_LEGAL_BASE_URL: insecureUrl,
      },
    });
    const output = `${result.stdout}${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain('EXPO_PUBLIC_LEGAL_BASE_URL');
    expect(output).not.toContain(insecureUrl);
  });

  test('requires a real HTTPS legal site for production builds', () => {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NODE_ENV: 'production' as const,
    };
    delete environment['EXPO_PUBLIC_LEGAL_BASE_URL'];
    const missing = spawnSync(process.execPath, [VERIFIER_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
      env: environment,
    });
    expect(missing.status).not.toBe(0);
    expect(`${missing.stdout}${missing.stderr}`).toContain('EXPO_PUBLIC_LEGAL_BASE_URL');

    const placeholder = spawnSync(process.execPath, [VERIFIER_PATH], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        EXPO_PUBLIC_LEGAL_BASE_URL: 'https://YOUR_LEGAL_SITE_DOMAIN',
      },
    });
    expect(placeholder.status).not.toBe(0);
    expect(`${placeholder.stdout}${placeholder.stderr}`).toContain('EXPO_PUBLIC_LEGAL_BASE_URL');
  });
});
