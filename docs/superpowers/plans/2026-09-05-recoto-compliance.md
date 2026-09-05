# Recoto UGC, Legal, and App Store Compliance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add group safety controls, public bilingual legal/support pages, in-app legal/delete access, and deterministic App Store submission artifacts that match actual Recoto behavior.

**Architecture:** Moderation actions are server-enforced RPCs backed by RLS, never client-only hiding. Legal pages are a small static Firebase Hosting site with one shared stylesheet and language switch. A release verifier cross-checks app config, manifest, URLs, and documentation so the product, privacy labels, and review notes stay aligned.

**Tech Stack:** Supabase Postgres/RLS/RPC, React Native, Expo Linking, Firebase Hosting static HTML/CSS/JS, Jest, Node verification scripts.

---

## File map

- Create `supabase/migrations/008_ugc_moderation.sql`: blocks, reports, bans, narrow group RPCs.
- Create `store/moderationStore.ts`, `components/groups/MemberActionsSheet.tsx`, `components/groups/ReportSheet.tsx`.
- Modify `store/groupStore.ts`, `components/groups/GroupDetailSheet.tsx`, `types/index.ts`, `constants/i18n.ts`.
- Create `constants/legal.ts`, `components/settings/LegalSupportSection.tsx`; modify Settings.
- Create `legal-site/firebase.json`, `.firebaserc.example`, and public bilingual pages/assets.
- Create `docs/moderation-runbook.md`, `docs/app-store/app-privacy-answers.md`, `docs/app-store/review-notes.md`, `docs/app-store/release-checklist.md`.
- Extend `scripts/verify-release-config.mjs`, `.env.example`, `DEPLOY_CHECKLIST.md`.

### Task 1: Enforce reporting, blocking, and owner moderation in Postgres

- [ ] **Step 1: Write failing SQL policy tests**

Create `tests/compliance/moderationMigration.test.ts` and assert the migration creates `user_blocks`, `content_reports`, and `group_bans`; enables RLS; revokes public access; permits reporters to insert but not read other reports; and exposes only narrowly named RPCs. Also add `supabase/tests/ugc_moderation_rls.sql` with two users and these assertions:

```sql
-- member B cannot read member A's report
-- non-owner B cannot ban or remove member A
-- owner can remove and ban B
-- banned B cannot rejoin using a valid invite code
-- blocked B's shared entries are absent from A's member-safe read RPC
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/compliance/moderationMigration.test.ts`.
Expected: FAIL because migration 008 is absent.

- [ ] **Step 3: Implement schema and least-privilege RPCs**

Create:

```sql
public.user_blocks(blocker_user_id uuid, blocked_user_id uuid, created_at timestamptz)
public.content_reports(id uuid, reporter_user_id uuid, group_id uuid, target_user_id uuid,
  shared_entry_id uuid, reason text, detail text, status text, created_at timestamptz, resolved_at timestamptz)
public.group_bans(group_id uuid, banned_user_id uuid, banned_by uuid, created_at timestamptz)
```

Add unique constraints, FKs, indexes, text length/reason checks, and owner/member RLS. Replace direct broad `groups` updates with `rename_group`, `update_group_memo`, `remove_and_ban_group_member`, `block_user`, `unblock_user`, and `report_group_content` RPCs. All `SECURITY DEFINER` functions use `search_path=''`, fully qualified names, and explicit grants to authenticated only.

- [ ] **Step 4: Verify GREEN and commit**

Run `npm test -- tests/compliance/moderationMigration.test.ts && git diff --check -- supabase`.
Commit as `feat: enforce group moderation policies`.

### Task 2: Add usable moderation controls

- [ ] **Step 1: Write failing store and UI tests**

Create `tests/compliance/moderationStore.test.ts` and `tests/compliance/GroupModeration.test.tsx`:

```ts
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { createModerationStore } from '../../store/moderationStore';
import { GroupMemberActions } from '../../components/groups/MemberActionsSheet';

const memberFixture = () => ({ id: 'member-2', name: 'Member 2', color: '#3B82F6' });
const sharedEntryFixture = (overrides = {}) => ({
  id: 'entry-1', groupId: 'group-1', userId: 'member-2', userName: 'Member 2',
  userColor: '#3B82F6', date: '2026-09-05', ...overrides,
});
const moderationApiFixture = () => ({
  fetchBlocks: jest.fn(async () => ['blocked-user']),
  blockUser: jest.fn(async () => undefined),
  unblockUser: jest.fn(async () => undefined),
  reportContent: jest.fn(async () => ({ status: 'received' as const })),
  removeAndBanMember: jest.fn(async () => undefined),
});

test('blocked member entries are filtered immediately and after refetch', async () => {
  const api = moderationApiFixture();
  const store = createModerationStore(api);
  store.setSharedEntries([sharedEntryFixture({ userId: 'blocked-user' })]);
  await store.blockUser('blocked-user');
  expect(store.getVisibleEntries()).toEqual([]);
  await store.fetchBlocks();
  expect(store.getVisibleEntries()).toEqual([]);
});

test('report submits an allowed reason and bounded detail', async () => {
  const api = moderationApiFixture();
  const store = createModerationStore(api);
  await store.reportContent({ sharedEntryId: 'entry-1', reason: 'spam', detail: 'Repeated invite links' });
  expect(api.reportContent).toHaveBeenCalledWith(expect.objectContaining({ reason: 'spam' }));
  expect(store.getState().lastReportStatus).toBe('received');
});

test('only an owner sees remove and prevent rejoin', () => {
  const owner = render(<GroupMemberActions role="owner" member={memberFixture()} />);
  expect(owner.getByText('削除して再参加を防ぐ')).toBeTruthy();
  const member = render(<GroupMemberActions role="member" member={memberFixture()} />);
  expect(member.queryByText('削除して再参加を防ぐ')).toBeNull();
});

test('a member can block another member', async () => {
  const onBlock = jest.fn(async () => undefined);
  const screen = render(<GroupMemberActions role="member" member={memberFixture()} onBlock={onBlock} />);
  fireEvent.press(screen.getByRole('button', { name: 'ブロック' }));
  await waitFor(() => expect(onBlock).toHaveBeenCalledWith('member-2'));
});
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/compliance/moderationStore.test.ts tests/compliance/GroupModeration.test.tsx`.
Expected: FAIL because store and sheets do not exist.

- [ ] **Step 3: Implement the moderation store**

Expose `fetchBlocks`, `blockUser`, `unblockUser`, `reportContent`, and `removeAndBanMember`. Preserve `SharedEntry.id` and `groupId` in the mapper so reports target a stable server row. Optimistically hide blocked content but roll back and show a recoverable message if the RPC fails.

- [ ] **Step 4: Implement sheets in the current group UI**

Member actions offer Block/Unblock and Report to all members, Remove and prevent rejoin only to owners, and never allow self-block. Report reasons are harassment, hate, sexual content, violence, personal information, spam/fraud, copyright, and other. Detail is optional, maximum 500 characters. Link Community Guidelines and `herac.7.app@gmail.com` from the sheet.

- [ ] **Step 5: Verify GREEN and commit**

Run `npm test -- tests/compliance/moderationStore.test.ts tests/compliance/GroupModeration.test.tsx && npm run typecheck`.
Commit as `feat: add reporting and member safety controls`.

### Task 3: Create the public bilingual legal/support site

- [ ] **Step 1: Write failing page-content tests**

Create `tests/compliance/legalPages.test.ts` that loads every HTML file and asserts:

```ts
const requiredPages = ['privacy', 'terms', 'support', 'delete-account', 'community-guidelines'];
expect(page).toContain('HERAC LLC');
expect(page).toContain('herac.7.app@gmail.com');
expect(page).toMatch(/lang="ja"/);
expect(page).toContain('data-lang="en"');
```

Privacy assertions must find Supabase, Google, Apple, calendar/user content/photos, retention, account deletion, international processing, and a standalone Google API Limited Use section. Terms assertions must find guest-data risk, third-party services, user content ownership, prohibited conduct, deletion, Japanese law, and Osaka District Court. Delete-account must match the implemented Settings route and retention periods.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/compliance/legalPages.test.ts`.
Expected: FAIL because the site is absent.

- [ ] **Step 3: Build one accessible static site**

Create a quiet, text-first site matching Recoto blue, with a 72-character max line length, skip link, visible keyboard focus, reduced-motion-safe behavior, responsive navigation, and no analytics/cookies. `site.js` only switches ja/en and stores that preference locally. Every page contains effective/updated date `2026-09-05`, links to all other pages, and a mailto support action.

The privacy page accurately states: no ads/tracking/analytics in v1; account ID/email/profile only when login is used; calendar, diary, special-date, stamp, trip, photo, and group content as entered; Supabase/Google/Apple/Expo as applicable processors; OAuth tokens excluded from personal backup; private storage and RLS; 90-day tombstones, 180-day report/audit retention, production backups up to 30 days; access/correction/deletion contact and in-app deletion. Do not promise absolute security.

- [ ] **Step 4: Add Firebase Hosting config**

Set `legal-site/firebase.json` public directory to `public`, clean URLs off, trailing slash off, no rewrites, and security headers for CSP, `X-Content-Type-Options`, `Referrer-Policy`, and frame denial. `.firebaserc.example` contains a literal `YOUR_FIREBASE_PROJECT_ID`, never a real credential.

- [ ] **Step 5: Verify GREEN and commit**

Run:

```bash
npm test -- tests/compliance/legalPages.test.ts
npm run check:legal
```

Serve `legal-site/public` locally and inspect all pages at narrow and desktop widths. Commit as `docs: add Recoto legal and support site`.

### Task 4: Link legal/support and deletion actions from Settings

- [ ] **Step 1: Write failing URL and UI tests**

Create `tests/compliance/legalUrl.test.ts` and `SettingsLegalSection.test.tsx`:

```ts
expect(buildLegalUrl('privacy', 'https://legal.recoto.example')).toBe('https://legal.recoto.example/privacy.html');
expect(() => buildLegalUrl('terms', 'http://insecure.example')).toThrow('https');
expect(getAllByRole('link')).toHaveLength(5);
expect(getByText('アカウントとデータを削除')).toBeTruthy();
```

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/compliance/legalUrl.test.ts tests/compliance/SettingsLegalSection.test.tsx`.
Expected: FAIL because constants/components do not exist.

- [ ] **Step 3: Implement safe links**

`constants/legal.ts` exposes five known page names only, strips a trailing slash from `EXPO_PUBLIC_LEGAL_BASE_URL`, rejects credentials/non-HTTPS in release, and never accepts an arbitrary path. `LegalSupportSection` opens links with `Linking.openURL`, shows an actionable setup message in development if unset, and places the Account deletion action visibly outside the legal-link list.

- [ ] **Step 4: Verify GREEN and commit**

Run `npm test -- tests/compliance/legalUrl.test.ts tests/compliance/SettingsLegalSection.test.tsx && npm run typecheck`.
Commit as `feat: add in-app legal and support access`.

### Task 5: Lock release metadata to actual behavior

- [ ] **Step 1: Write failing manifest/release tests**

Create `tests/compliance/privacyManifest.test.ts` and extend the release verifier to require: app-owned manifest in the Xcode target; `NSPrivacyTracking=false`; no tracking domains; only reason codes justified by built artifacts; five HTTPS legal URLs; Apple login parity when Google backup login is visible; in-app deletion copy; valid app/notification icons; and no secret-like `EXPO_PUBLIC_` values.

- [ ] **Step 2: Verify RED**

Run `npm test -- tests/compliance/privacyManifest.test.ts && npm run verify:config`.
Expected: FAIL on any unaligned release item.

- [ ] **Step 3: Create submission documents**

`app-privacy-answers.md` lists each App Store data category and whether linked to identity, using only implemented collection. `review-notes.md` gives exact navigation for guest calendar/travel/diary, Apple/Google backup, separate Google Calendar permission, group invite, report/block, and Settings account deletion. `release-checklist.md` covers Xcode 26/iOS 26 SDK, archive privacy report, real-device auth, clean install/upgrade/reinstall, two-account RLS, legal links on cellular data, and backend uptime.

- [ ] **Step 4: Add moderation operations**

`moderation-runbook.md` gives HERAC LLC a repeatable queue review process: acknowledge reports, preserve minimal evidence, prioritize imminent harm, remove/ban where warranted, notify parties without exposing reporter identity, handle appeals by email, and delete/anonymous reports after 180 days.

- [ ] **Step 5: Verify local release evidence**

Run:

```bash
npm run verify
git diff --check
```

Then produce a Release archive and Xcode Privacy Report. External console items that cannot run without owner credentials remain clearly unchecked release blockers; do not simulate their completion.

- [ ] **Step 6: Commit**

Commit verifier changes and App Store/moderation documents as `docs: add App Store release evidence`.
