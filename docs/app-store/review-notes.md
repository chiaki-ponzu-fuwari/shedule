# Recoto App Review Notes 入力案

最終更新: 2026-09-05
対象: iOS 1.0.0 / `com.herac.recoto`

> この追跡ファイルでは`<...>`を残します。App Store Connectへ貼り付けたコピーだけを本番値へ置換してください。パスワードはGitに保存しないでください。認証情報はApp Store Connectの審査用欄にだけ入力します。

## 審査用情報

- Review account A: `<APP_REVIEW_TEST_ACCOUNT_A>`
- Review account A provider/button: `<APP_REVIEW_PROVIDER_A>`
- Review account B: `<APP_REVIEW_TEST_ACCOUNT_B>`
- Review account B provider/button: `<APP_REVIEW_PROVIDER_B>`
- Deletion-only account: `<APP_REVIEW_DELETION_ACCOUNT>`
- Deletion-only account provider/button: `<APP_REVIEW_DELETION_PROVIDER>`
- Passwords: `<ENTER_ONLY_IN_APP_STORE_CONNECT>`
- 有効なグループ招待コード: `<CURRENT_GROUP_INVITE_CODE>`
- Privacy Policy: `<PRODUCTION_PRIVACY_URL>`
- Support: `<PRODUCTION_SUPPORT_URL>`
- 連絡先: `herac.7.app@gmail.com`

Provider/button欄は、Googleなら`Google — Save with Google`、Appleなら`Apple — Continue with Apple`と、審査buildに表示されるボタン名をそのまま記載します。

招待コードは128-bit・32文字の大文字16進数で、セキュリティmigration適用時に旧コードが無効になります。審査提出直前に、Aが所有するグループで現在のコードを再取得してください。

## Paste-ready English notes

Recoto is a shared calendar and personal trip planner. Sign-in is optional: the reviewer can launch the app and use the Calendar and Travel tabs as a guest without creating an account. A fresh installation starts in Japanese; to follow the English labels below, open the **Settings（設定）** tab and select **EN** in the language selector at the top.

1. **Guest use:** Launch the app; no login screen is shown. In Calendar, select a date and tap the lower-right **+** button to add a stamp, schedule, photo, or local reminder. To add a diary entry, switch to Week view, select a date, tap the **Write a diary entry…** input, enter text, and tap **Done**. Open Travel and tap **Add Trip** to save a date range, color, start/end transport marker, and itinerary items such as flights, trains, hotels, reservation numbers, HTTP/HTTPS links, and notes.
2. **Cloud backup:** Open Settings and scroll to the **Backup account** heading. Use the provider/button listed for the review account in App Store Connect. **Save with Google** and **Continue with Apple** are equivalent optional sign-in choices. This sign-in requests identity only and does not request Google Calendar permission. A connected account backs up personal calendar, special dates, stamps, trips, itineraries, and selected personal images to private Supabase storage.
3. **Restore:** Use review account A on a second clean installation. After sign-in and identity verification, saved personal data is restored before the account-owned UI is shown.
4. **Groups:** Open Groups. Create a group or join the prepared review group using `<CURRENT_GROUP_INVITE_CODE>`. Review account B is available for two-user tests.
5. **Report and block:** In the prepared group, open **Info**, then tap **…** beside the other member to choose **Report** or **Block**. A shared schedule can also be reported with its flag action. The group owner can remove a member and prevent rejoining. Reports are not readable by ordinary clients. Please unblock account B afterward and do not remove it from the shared fixture.
6. **Account deletion:** Use `<APP_REVIEW_DELETION_ACCOUNT>` with `<APP_REVIEW_DELETION_PROVIDER>`. Open Settings, scroll to the **Backup account** heading, and select **Delete account and data**. The sheet explains the affected Recoto account, cloud data, group membership/content, local cache, notifications, and provider access. Deletion is irreversible. Original events stored at an external provider such as Google Calendar are not deleted.
7. **Legal and support:** The bottom of Settings contains Privacy Policy, Terms of Use, Community Guidelines, Support, and Account/Data Deletion links.

The iOS version does not display Google Calendar integration because that separate feature is currently Web-only. Google account sign-in shown in the backup card is solely for Recoto identity and backup.

The production backend and legal HTTPS site will remain available throughout review. Please contact `herac.7.app@gmail.com` if access assistance is needed.

## 社内確認用の日本語導線

1. **ゲスト**: 起動後すぐ「カレンダー」と「旅行」を操作できる。
2. **旅行**: 「旅行」タブ > 「旅行を追加」。旅行名、期間、色、車/飛行機/電車の始終点、飛行機・ホテル等の旅程を登録。
3. **Google / Apple保存**: 「設定」を開き、「データ保存用アカウント」の見出しまでスクロール。どちらも任意で、Google Calendar権限とは別。
4. **グループ**: 「グループ」タブで作成、または現在の招待コードで参加。
5. **通報 / ブロック**: グループ詳細のメンバーまたは共有予定を開き、「通報」または「ブロック」。
6. **削除**: 「設定」で「データ保存用アカウント」の見出しまでスクロールし、「アカウントとデータを削除」。
7. **法務リンク**: 「設定」最下部。

iOS版ではGoogle Calendar連携を表示しない。「Googleで保存」はバックアップ用の本人確認で、Calendarの読み書き権限は要求しない。

## 提出前に必ず置換・確認する項目

- [ ] 2つの審査用アカウントが本番Supabaseでログインでき、各providerと押すボタンをApp Store Connectのコピーへ明記した。
- [ ] 共有fixtureを壊さない削除専用アカウントが本番Supabaseでログインでき、providerを明記した。
- [ ] A/Bの間に、通報・ブロックを確認できる無害な共有予定を用意する。
- [ ] App Store Connectへ貼り付けたコピー内の`<CURRENT_GROUP_INVITE_CODE>`を提出当日の現在値へ置換する。
- [ ] App Store Connectへ貼り付けたコピー内のURL・アカウント・provider placeholderを本番値へ置換する（この追跡ファイルは置換しない）。
- [ ] 日本語とPaste-ready English notesの手順が同じビルドで再現できる。
- [ ] 審査中にSupabase、Edge Functions、Apple/Google OAuth、法務サイトを停止しない。
