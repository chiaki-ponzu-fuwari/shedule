# Recoto Release Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing app boot safely as Recoto, establish repeatable tests, and add the native privacy/permission foundation required before account or travel work.

**Architecture:** Keep personal calendar data available without a network session. Supabase configuration and an anonymous session become lazy dependencies used only by group/account actions. Release metadata is verified by a deterministic Node script so Expo config, native iOS identifiers, assets, and privacy declarations cannot silently drift.

**Tech Stack:** Expo SDK 52, React Native 0.76, Expo Router, Zustand, Supabase JS, Jest/jest-expo, React Native Testing Library, Node verification scripts.

---

## File map

- Create `jest.config.js`: Expo-aware test configuration.
- Create `tests/setup.ts`: deterministic native mocks.
- Create `tests/auth/sessionBootstrap.test.ts`: guest-first auth state tests.
- Create `tests/releaseConfig.test.ts`: static release metadata tests.
- Create `lib/auth/sessionBootstrap.ts`, `store/appSessionStore.ts`: pure bootstrap plus identity/cloud state and a deduplicated lazy anonymous-session service.
- Modify `lib/supabase.ts`: non-throwing optional configuration and explicit guard.
- Modify `hooks/useSupabaseAuth.ts`: observe restored sessions without auto-creating a user.
- Modify `app/_layout.tsx`: always render personal UI after local hydration; remove launch-time notification prompt.
- Modify `store/groupStore.ts`, `app/(tabs)/groups.tsx`, `app/join/[code].tsx`: request a connected anonymous session only for group actions.
- Modify `hooks/useGoogleAuth.ts`, `hooks/useGoogleAuth.web.ts`, `hooks/useGoogleAuth.native.ts`, `app/(tabs)/settings.tsx`: remove unsupported `useProxy` options and preserve the existing Calendar OAuth behavior.
- Modify `app.json`, `ios/app.xcodeproj/project.pbxproj`, `ios/app/Info.plist`: unify Recoto identifiers and permission metadata.
- Create `ios/app/PrivacyInfo.xcprivacy`: app-owned privacy manifest.
- Create `assets/images/icon.png`: provisional Recoto release icon used by Expo and notifications.
- Create `scripts/verify-release-config.mjs`: fail closed on release configuration drift.
- Modify `.gitignore`, `.env.example`, `package.json`, `package-lock.json`: ignore local artifacts, document config, and expose verification commands.
- Modify all photo-picker call sites: launch the system picker without a pre-emptive full-library permission prompt.

### Task 1: Preserve the current working baseline and install tests

- [ ] **Step 1: Record the known-red baseline**

Run:

```bash
git status --short
./node_modules/.bin/tsc --noEmit
```

Expected: the current user changes remain present and TypeScript reports the four known `useProxy` errors only. Save the command output in the task log; do not alter those files yet.

- [ ] **Step 2: Update ignore rules before snapshotting**

Append these exact entries to `.gitignore`:

```gitignore
.DS_Store
.superpowers/
coverage/
```

- [ ] **Step 3: Snapshot the inherited work without generated files**

Stage the existing source, migration, and documentation files explicitly; exclude `.DS_Store` and `.superpowers/`. Commit as:

```bash
git commit -m "chore: preserve pre-Recoto app progress"
```

- [ ] **Step 4: Install the Expo-compatible test stack**

Run:

```bash
npx expo install jest-expo @testing-library/react-native react-test-renderer -- --save-dev
npm install --save-dev @types/jest
```

Expected: `package-lock.json` updates and `node_modules/.bin/jest` exists.

- [ ] **Step 5: Add test and verification scripts**

Set the relevant `package.json` fields to:

```json
{
  "scripts": {
    "test": "jest --runInBand",
    "test:watch": "jest --watch",
    "typecheck": "tsc --noEmit",
    "verify:config": "node scripts/verify-release-config.mjs",
    "verify": "npm run typecheck && npm test && npm run verify:config"
  }
}
```

Create `jest.config.js`:

```js
module.exports = {
  preset: 'jest-expo',
  setupFilesAfterEnv: ['<rootDir>/tests/setup.ts'],
  testPathIgnorePatterns: ['/node_modules/', '/app/'],
  collectCoverageFrom: ['lib/**/*.{ts,tsx}', 'utils/**/*.{ts,tsx}', 'store/**/*.{ts,tsx}'],
};
```

Create `tests/setup.ts`:

```ts
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
```

- [ ] **Step 6: Run the empty suite**

Run `npm test -- --passWithNoTests`.
Expected: exit 0.

- [ ] **Step 7: Commit the harness**

```bash
git add .gitignore package.json package-lock.json jest.config.js tests/setup.ts
git commit -m "test: add Expo verification harness"
```

### Task 2: Make Supabase optional at boot

- [ ] **Step 1: Write the failing bootstrap tests**

Create `tests/auth/sessionBootstrap.test.ts`:

```ts
import { decideInitialSession, shouldCreateAnonymousSession } from '../../lib/auth/sessionBootstrap';

describe('session bootstrap', () => {
  test('uses local guest mode when Supabase is not configured', () => {
    expect(decideInitialSession({ configured: false, user: null })).toEqual({
      identityMode: 'guest-local',
      cloudAvailability: 'misconfigured',
      userId: null,
    });
  });

  test('does not create an anonymous account during app launch', () => {
    expect(shouldCreateAnonymousSession('app-launch')).toBe(false);
  });

  test('creates an anonymous account only for a group action', () => {
    expect(shouldCreateAnonymousSession('group-action')).toBe(true);
  });
});
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/auth/sessionBootstrap.test.ts`.
Expected: FAIL because `lib/auth/sessionBootstrap.ts` does not exist.

- [ ] **Step 3: Implement the pure decision contract**

Create `lib/auth/sessionBootstrap.ts` with these exports:

```ts
export type IdentityMode =
  | 'hydrating'
  | 'guest-local'
  | 'guest-connected'
  | 'account-connected'
  | 'deletion-pending';

export type CloudAvailability = 'unknown' | 'online' | 'offline' | 'misconfigured';

type BootstrapInput = { configured: boolean; user: { id: string; is_anonymous?: boolean } | null };

export function decideInitialSession(input: BootstrapInput) {
  if (!input.configured) {
    return { identityMode: 'guest-local' as const, cloudAvailability: 'misconfigured' as const, userId: null };
  }
  if (!input.user) {
    return { identityMode: 'guest-local' as const, cloudAvailability: 'online' as const, userId: null };
  }
  return {
    identityMode: input.user.is_anonymous ? ('guest-connected' as const) : ('account-connected' as const),
    cloudAvailability: 'online' as const,
    userId: input.user.id,
  };
}

export function shouldCreateAnonymousSession(reason: 'app-launch' | 'group-action' | 'account-link') {
  return reason !== 'app-launch';
}
```

- [ ] **Step 4: Make `lib/supabase.ts` non-throwing**

Export a non-throwing configuration boundary:

```ts
export function isSupabaseConfigured(): boolean;
export function getSupabaseClient(): SupabaseClient | null;
export function requireSupabaseClient(): SupabaseClient;
```

`requireSupabaseClient()` throws the localized recoverable configuration error. No call may perform a network request without obtaining a non-null client through this boundary.

- [ ] **Step 5: Change the root observer and group entry points**

`useSupabaseAuth` must set `ready=true` for an unconfigured client or a restored null session and must never call `signInAnonymously` on `INITIAL_SESSION`. `store/appSessionStore.ts` keeps `identityMode` separate from `cloudAvailability`; its `ensureGuestSession()` reuses one module-level in-flight promise so concurrent group actions create at most one anonymous user. Invoke it before create/join/fetch group actions and before processing `join/[code]`.

- [ ] **Step 6: Remove boot blocking and launch-time notification permission**

`app/_layout.tsx` must render the router after local hydration whether Supabase is online or not. Remove the `requestNotificationPermission()` effect and the full-screen Supabase error branch. Keep a nonblocking connection status for Settings.

- [ ] **Step 7: Verify GREEN and type safety**

Run:

```bash
npm test -- tests/auth/sessionBootstrap.test.ts
npm run typecheck
```

Expected: bootstrap tests pass. Typecheck may still show only the pre-existing `useProxy` errors until Task 3.

- [ ] **Step 8: Commit the guest-first boot**

```bash
git add lib/supabase.ts lib/auth/sessionBootstrap.ts store/appSessionStore.ts hooks/useSupabaseAuth.ts app/_layout.tsx store/groupStore.ts 'app/(tabs)/groups.tsx' 'app/join/[code].tsx' tests/auth/sessionBootstrap.test.ts
git commit -m "feat: allow offline guest startup"
```

### Task 3: Clear the existing OAuth type errors without changing registered redirects

- [ ] **Step 1: Add a static failing test**

Create `tests/auth/calendarOAuthContract.test.ts`:

```ts
import fs from 'node:fs';

test('does not pass removed useProxy options to Expo AuthSession', () => {
  const files = [
    'hooks/useGoogleAuth.ts',
    'hooks/useGoogleAuth.web.ts',
    'hooks/useGoogleAuth.native.ts',
    'app/(tabs)/settings.tsx',
  ];
  for (const file of files) {
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/\buseProxy\b/);
  }
});

test('keeps the currently registered web Calendar OAuth path', () => {
  const web = fs.readFileSync('hooks/useGoogleAuth.web.ts', 'utf8');
  expect(web).toMatch(/makeRedirectUri\(\{\s*path:\s*['"]auth['"]\s*\}\)/);
});
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/auth/calendarOAuthContract.test.ts`.
Expected: FAIL on current `useProxy` calls.

- [ ] **Step 3: Remove unsupported options**

Call `promptAsync()` without arguments and remove `useProxy` from `makeRedirectUri`, hook return values, and Settings destructuring. Preserve the working Web Calendar OAuth path as `AuthSession.makeRedirectUri({ path: 'auth' })`; changing it would require a coordinated Google Cloud allow-list update. The native hook remains its existing safe disabled stub until the account/native-auth workstream supplies a development-build flow. Task 4 changes the app scheme to `recoto` and updates the fallback hook without changing the registered Web path.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
npm test -- tests/auth/calendarOAuthContract.test.ts
npm run typecheck
```

Expected: test passes and TypeScript reports zero errors.

- [ ] **Step 5: Commit**

```bash
git add hooks/useGoogleAuth.ts hooks/useGoogleAuth.web.ts hooks/useGoogleAuth.native.ts 'app/(tabs)/settings.tsx' tests/auth/calendarOAuthContract.test.ts
git commit -m "fix: remove obsolete Calendar OAuth proxy options"
```

### Task 4: Unify the Recoto release identity and privacy manifest

- [ ] **Step 1: Write failing release configuration tests**

Create `tests/releaseConfig.test.ts` that parses `app.json`, `ios/app/Info.plist`, and `ios/app.xcodeproj/project.pbxproj`, asserting:

```ts
expect(config.expo.name).toBe('レコト');
expect(config.expo.slug).toBe('recoto');
expect(config.expo.scheme).toBe('recoto');
expect(config.expo.ios.bundleIdentifier).toBe('com.herac.recoto');
expect(config.expo.android.package).toBe('com.herac.recoto');
expect(pbxproj).not.toContain('org.name.app');
expect(fs.existsSync('ios/app/PrivacyInfo.xcprivacy')).toBe(true);
expect(fs.existsSync('assets/images/icon.png')).toBe(true);
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/releaseConfig.test.ts`.
Expected: FAIL on the old name and identifiers.

- [ ] **Step 3: Update Expo and native identifiers**

Set `name=レコト`, `slug=recoto`, `scheme=recoto`, and both package identifiers to `com.herac.recoto`. Add an `expo-image-picker` plugin entry with Japanese photo purpose text and `microphonePermission=false`, and point icon/splash/notification icon to existing files under `assets/images`. Add `ios.usesAppleSignIn` only in the account plan together with the working Apple login and entitlement.

Replace both Xcode `PRODUCT_BUNDLE_IDENTIFIER` values with `com.herac.recoto`, add the `recoto` callback scheme to `CFBundleURLTypes`, and ensure the display name resolves to `レコト`.

- [ ] **Step 4: Add the app-owned manifest**

Create `ios/app/PrivacyInfo.xcprivacy` with `NSPrivacyTracking=false`, an empty tracking-domain array, `NSPrivacyAccessedAPICategoryFileTimestamp/C617.1`, `NSPrivacyAccessedAPICategoryUserDefaults/CA92.1`, and only the user-content/photo collection already performed by the current app. Add it to the app target resources. The account/compliance plans extend collected-data declarations when login is implemented.

- [ ] **Step 5: Add deterministic config verification**

Create `scripts/verify-release-config.mjs` to parse `app.json`, verify the exact identifiers, ensure all configured local assets exist, require `PrivacyInfo.xcprivacy`, reject `http:` legal URLs in production, and reject `EXPO_PUBLIC_*` names containing `SECRET`, `SERVICE_ROLE`, or `PRIVATE_KEY`.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
npm test -- tests/releaseConfig.test.ts
npm run verify:config
npx expo config --type public
```

Expected: all three commands exit 0 and the Expo output shows `com.herac.recoto`.

- [ ] **Step 7: Commit**

```bash
git add app.json ios/app.xcodeproj/project.pbxproj ios/app/Info.plist ios/app/PrivacyInfo.xcprivacy assets/images/icon.png scripts/verify-release-config.mjs tests/releaseConfig.test.ts .env.example
git commit -m "chore: adopt Recoto release identity"
```

### Task 5: Make photo and notification permissions contextual

- [ ] **Step 1: Write failing static permission tests**

Create `tests/permissions/contextualPermissions.test.ts`:

```ts
import fs from 'node:fs';

const photoCallSites = [
  'app/(tabs)/settings.tsx',
  'app/(tabs)/groups.tsx',
  'components/groups/GroupDetailSheet.tsx',
  'components/modals/DayDetailSheet.tsx',
  'components/calendar/WeeklyView.tsx',
];

test('system image selection does not request broad library access first', () => {
  for (const file of photoCallSites) {
    expect(fs.readFileSync(file, 'utf8')).not.toContain('requestMediaLibraryPermissionsAsync');
  }
});

test('notification permission is not requested by root layout', () => {
  expect(fs.readFileSync('app/_layout.tsx', 'utf8')).not.toContain('requestNotificationPermission');
});
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/permissions/contextualPermissions.test.ts`.
Expected: FAIL on current picker call sites.

- [ ] **Step 3: Remove broad photo preflight calls**

At each call site, invoke `launchImageLibraryAsync` directly from the user tap. Preserve cancellation and compression handling. The existing notification editors keep calling `requestNotificationPermission()` only when the user switches a notification on.

- [ ] **Step 4: Verify GREEN and full foundation**

Run:

```bash
npm test -- tests/permissions/contextualPermissions.test.ts
npm run verify
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 5: Browser smoke test**

Start the web app, open Calendar, Groups, and Settings, then confirm the app still opens with Supabase env values removed and group actions show a recoverable configuration message.

- [ ] **Step 6: Commit**

```bash
git add 'app/(tabs)/settings.tsx' 'app/(tabs)/groups.tsx' components/groups/GroupDetailSheet.tsx components/modals/DayDetailSheet.tsx components/calendar/WeeklyView.tsx tests/permissions/contextualPermissions.test.ts
git commit -m "fix: request permissions in context"
```
