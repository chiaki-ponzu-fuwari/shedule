#!/usr/bin/env node

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const plist = require('@expo/plist').default;
const root = process.cwd();
const failures = [];

const expectedIdentity = {
  name: 'レコト',
  slug: 'recoto',
  scheme: 'recoto',
  iosBundleIdentifier: 'com.herac.recoto',
  androidPackage: 'com.herac.recoto',
};

const expectedAssets = {
  appIcon: './assets/images/icon.png',
  splashImage: './assets/images/icon.png',
  notificationIcon: './assets/images/notification-icon.png',
  iosAppIconFilename: 'AppIcon-1024.png',
};

function addFailure(message) {
  failures.push(message);
}

function readJson(relativePath) {
  const filePath = path.join(root, relativePath);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    addFailure(`${relativePath} must exist and contain valid JSON.`);
    return null;
  }
}

function readPlist(relativePath) {
  const filePath = path.join(root, relativePath);
  try {
    return plist.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    addFailure(`${relativePath} must exist and contain a valid plist.`);
    return null;
  }
}

function expectEqual(label, actual, expected) {
  if (actual !== expected) addFailure(`${label} must be ${JSON.stringify(expected)}.`);
}

function visit(value, currentPath, visitor) {
  visitor(value, currentPath);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => visit(entry, `${currentPath}[${index}]`, visitor));
  } else if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, entry]) =>
      visit(entry, currentPath ? `${currentPath}.${key}` : key, visitor),
    );
  }
}

function verifyLocalAssets(config) {
  const localAssets = new Set();
  visit(config, 'expo', (value) => {
    if (typeof value === 'string' && /^\.\.?\//.test(value)) localAssets.add(value);
  });

  for (const asset of localAssets) {
    const assetPath = path.resolve(root, asset);
    if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) {
      addFailure(`Configured local asset is missing: ${asset}`);
    }
  }
}

function pluginOptions(expo, pluginName) {
  const entry = Array.isArray(expo.plugins)
    ? expo.plugins.find((plugin) => Array.isArray(plugin) && plugin[0] === pluginName)
    : undefined;
  return Array.isArray(entry) ? entry[1] : undefined;
}

function verifyReleaseAssetMappings(expo) {
  expectEqual('expo.icon', expo.icon, expectedAssets.appIcon);
  expectEqual('expo.splash.image', expo.splash?.image, expectedAssets.splashImage);
  expectEqual(
    'expo-notifications icon',
    pluginOptions(expo, 'expo-notifications')?.icon,
    expectedAssets.notificationIcon,
  );

  const contentsPath = 'ios/app/Images.xcassets/AppIcon.appiconset/Contents.json';
  const contents = readJson(contentsPath);
  if (!contents) return;
  const iosAppIcon = Array.isArray(contents.images)
    ? contents.images.find(
        (image) =>
          image.idiom === 'universal' && image.platform === 'ios' && image.size === '1024x1024',
      )
    : undefined;
  expectEqual(
    'iOS AppIcon Contents filename',
    iosAppIcon?.filename,
    expectedAssets.iosAppIconFilename,
  );

  const iosAppIconPath = path.join(
    root,
    'ios/app/Images.xcassets/AppIcon.appiconset',
    expectedAssets.iosAppIconFilename,
  );
  if (!fs.existsSync(iosAppIconPath) || !fs.statSync(iosAppIconPath).isFile()) {
    addFailure(`iOS AppIcon file is missing: ${expectedAssets.iosAppIconFilename}`);
  }
}

function verifyProductionLegalUrls(config) {
  if (process.env.NODE_ENV !== 'production') return;

  const isLegalUrlField = (field) =>
    /(?:privacy|terms|legal).*(?:url|uri)|(?:url|uri).*(?:privacy|terms|legal)/i.test(field);

  visit(config, 'expo', (value, currentPath) => {
    if (isLegalUrlField(currentPath) && typeof value === 'string' && /^http:\/\//i.test(value)) {
      addFailure(`Production legal URL must use HTTPS: ${currentPath}`);
    }
  });

  for (const [name, value] of Object.entries(process.env)) {
    if (
      name.startsWith('EXPO_PUBLIC_') &&
      isLegalUrlField(name) &&
      typeof value === 'string' &&
      /^http:\/\//i.test(value)
    ) {
      addFailure(`Production public legal URL must use HTTPS: ${name}`);
    }
  }
}

function configuredPublicEnvironmentNames() {
  const names = new Set(Object.keys(process.env).filter((name) => name.startsWith('EXPO_PUBLIC_')));
  const environmentFiles = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\.env(?:\..+)?$/.test(entry.name))
    .map((entry) => path.join(root, entry.name));

  for (const environmentFile of environmentFiles) {
    for (const line of fs.readFileSync(environmentFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(EXPO_PUBLIC_[A-Z0-9_]+)\s*=/i);
      if (match) names.add(match[1]);
    }
  }
  return names;
}

function verifyPublicEnvironmentNames() {
  const forbidden = /(?:SECRET|SERVICE_ROLE|PRIVATE_KEY)/i;
  for (const name of configuredPublicEnvironmentNames()) {
    if (forbidden.test(name)) {
      addFailure(`Unsafe public environment variable name: ${name}`);
    }
  }
}

function verifyPrivacyManifest() {
  const manifest = readPlist('ios/app/PrivacyInfo.xcprivacy');
  if (!manifest) return;

  if (manifest.NSPrivacyTracking !== false) {
    addFailure('Privacy manifest must set NSPrivacyTracking to false.');
  }
  if (!Array.isArray(manifest.NSPrivacyTrackingDomains) || manifest.NSPrivacyTrackingDomains.length) {
    addFailure('Privacy manifest tracking domains must be an empty array.');
  }

  const accessedApis = Array.isArray(manifest.NSPrivacyAccessedAPITypes)
    ? manifest.NSPrivacyAccessedAPITypes
    : [];
  const reasons = new Map(
    accessedApis.map((entry) => [entry.NSPrivacyAccessedAPIType, entry.NSPrivacyAccessedAPITypeReasons]),
  );
  const expectedReasons = new Map([
    ['NSPrivacyAccessedAPICategoryFileTimestamp', ['C617.1']],
    ['NSPrivacyAccessedAPICategoryUserDefaults', ['CA92.1']],
  ]);
  for (const [apiType, expected] of expectedReasons) {
    if (JSON.stringify(reasons.get(apiType)) !== JSON.stringify(expected)) {
      addFailure(`Privacy manifest must declare ${apiType} reason ${expected[0]}.`);
    }
  }

  const collectedData = Array.isArray(manifest.NSPrivacyCollectedDataTypes)
    ? manifest.NSPrivacyCollectedDataTypes
    : [];
  const expectedCollectedTypes = new Set([
    'NSPrivacyCollectedDataTypeUserID',
    'NSPrivacyCollectedDataTypeName',
    'NSPrivacyCollectedDataTypeOtherUserContent',
  ]);
  const actualCollectedTypes = new Set(
    collectedData.map((entry) => entry.NSPrivacyCollectedDataType),
  );
  if (
    actualCollectedTypes.size !== expectedCollectedTypes.size ||
    [...expectedCollectedTypes].some((type) => !actualCollectedTypes.has(type))
  ) {
    addFailure('Privacy manifest collected-data declarations do not match the current app.');
  }
  for (const entry of collectedData) {
    if (
      entry.NSPrivacyCollectedDataTypeLinked !== true ||
      entry.NSPrivacyCollectedDataTypeTracking !== false ||
      JSON.stringify(entry.NSPrivacyCollectedDataTypePurposes) !==
        JSON.stringify(['NSPrivacyCollectedDataTypePurposeAppFunctionality'])
    ) {
      addFailure(
        `Privacy manifest has invalid flags or purposes for ${entry.NSPrivacyCollectedDataType}.`,
      );
    }
  }
}

function verifyNativeIosIdentity() {
  const info = readPlist('ios/app/Info.plist');
  if (info) {
    expectEqual('Info.plist CFBundleDisplayName', info.CFBundleDisplayName, expectedIdentity.name);
    expectEqual('Info.plist CFBundleName', info.CFBundleName, expectedIdentity.name);
    const urlSchemes = Array.isArray(info.CFBundleURLTypes)
      ? info.CFBundleURLTypes.flatMap((entry) => entry.CFBundleURLSchemes ?? [])
      : [];
    if (!urlSchemes.includes(expectedIdentity.scheme)) {
      addFailure(`Info.plist must register the ${expectedIdentity.scheme} URL scheme.`);
    }
  }

  const pbxprojPath = path.join(root, 'ios/app.xcodeproj/project.pbxproj');
  if (!fs.existsSync(pbxprojPath)) {
    addFailure('ios/app.xcodeproj/project.pbxproj must exist.');
    return;
  }
  const pbxproj = fs.readFileSync(pbxprojPath, 'utf8');
  const bundleIdentifiers = [...pbxproj.matchAll(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)].map(
    (match) => match[1],
  );
  if (
    bundleIdentifiers.length !== 2 ||
    bundleIdentifiers.some((identifier) => identifier !== expectedIdentity.iosBundleIdentifier)
  ) {
    addFailure('iOS Debug and Release bundle identifiers must both be com.herac.recoto.');
  }
  if (!pbxproj.includes('PrivacyInfo.xcprivacy in Resources')) {
    addFailure('PrivacyInfo.xcprivacy must be included in the iOS target resources.');
  }
}

const appConfig = readJson('app.json');
if (appConfig?.expo) {
  const { expo } = appConfig;
  expectEqual('expo.name', expo.name, expectedIdentity.name);
  expectEqual('expo.slug', expo.slug, expectedIdentity.slug);
  expectEqual('expo.scheme', expo.scheme, expectedIdentity.scheme);
  expectEqual('expo.ios.bundleIdentifier', expo.ios?.bundleIdentifier, expectedIdentity.iosBundleIdentifier);
  expectEqual('expo.android.package', expo.android?.package, expectedIdentity.androidPackage);
  verifyReleaseAssetMappings(expo);
  verifyLocalAssets(expo);
  verifyProductionLegalUrls(expo);
} else if (appConfig) {
  addFailure('app.json must contain an expo object.');
}

verifyNativeIosIdentity();
verifyPrivacyManifest();
verifyPublicEnvironmentNames();

if (failures.length) {
  console.error('Release configuration verification failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('Release configuration verified.');
}
