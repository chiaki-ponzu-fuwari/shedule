# RECOTO リリース前チェックリスト

コードで自動化できる項目と、Google・Apple・Supabase・App Store Connectで人が確認する項目を分けています。外部設定は、まずステージングで実施してから本番へ反映してください。

## 0. ローカル自動検証

```bash
npm ci
npm run verify
npm run check:legal
npm run check:edge
NODE_ENV=production npm run verify:config
```

- Xcode 26 / iOS 26 SDKでReleaseビルドとArchiveを行う。
- 実機でAppleログイン、Googleログイン、ゲスト利用、復元、削除、通知、写真選択を確認する。
- `npm audit --json` と `npm audit --omit=dev --json` を保存する。`npm audit fix --force` はExpoのメジャー更新を起こし得るため、結果を確認せず実行しない。

## 1. 固定するリリース識別情報

- 表示名: `レコト`
- slug / scheme: `recoto`
- iOS Bundle ID / Android package: `com.herac.recoto`
- 問い合わせ: `herac.7.app@gmail.com`
- [要確認] App Store Connectで「レコト」の名称を予約できること。
- [要確認] J-PlatPatで名称・称呼、第9類・第42類等の商標衝突を確認すること。

## 2. Supabase 本番環境

1. 本番DBのバックアップを取得し、既存の旧形式ユーザーID・グループ参加データの移行方法を確認する。
2. ステージングで次のSQLを番号順に全文適用し、成功後に本番へ適用する。

   - `supabase/migrations/000_group_base_schema.sql`
   - `supabase/migrations/001_auth_rls_rpc.sql`
   - `supabase/migrations/002_rls_no_recursion.sql`
   - `supabase/migrations/003_security_hardening.sql`
   - `supabase/migrations/004_group_owner_limit.sql`
   - `supabase/migrations/005_personal_cloud.sql`
   - `supabase/migrations/006_account_lifecycle.sql`
   - `supabase/migrations/007_ugc_moderation.sql`
   - `supabase/migrations/008_apple_account_events.sql`
   - `supabase/migrations/009_group_invite_security.sql`

   `009` は推測可能だった旧招待コードをすべて128-bitの新コードへ更新します。適用後は過去に共有した招待リンクが無効になるため、既存グループのオーナーへ再共有を案内してください。

3. Authentication設定で次を有効にする。

   - Anonymous sign-ins
   - Allow manual linking
   - Google provider
   - Apple provider

4. Authの許可リダイレクトURLに、利用する環境だけを完全一致で登録する。

   - iOS/Android: `recoto://auth/callback`
   - Web本番: `https://<APP_DOMAIN>/auth/callback`
   - ローカルWeb: 実際に使用する `http://localhost:<PORT>/auth/callback`

5. `supabase/functions/README.md` に従って次をデプロイする。

   - `start-account-merge`
   - `complete-account-merge`
   - `cancel-account-merge`
   - `store-apple-token`
   - `apple-credential-status`
   - `start-account-deletion`
   - `delete-account`
   - `account-deletion-status`
   - `apple-account-notification`

   `account-deletion-status` はAuth削除後の256-bit回復レシート、`apple-account-notification` はApple署名済みJWSをそれぞれ検証するため、`supabase/config.toml` で `verify_jwt = false` にしています。その他はJWT検証を有効のままにします。

6. Edge Function secretsを設定する。アプリの `.env` や `EXPO_PUBLIC_*` には絶対に入れない。

   - `ALLOWED_WEB_ORIGINS`（本番HTTPS originの完全一致、カンマ区切り）
   - `GOOGLE_OAUTH_CLIENT_IDS`（許可するGoogleクライアントID、カンマ区切り）
   - `APPLE_CLIENT_ID`
   - `APPLE_NOTIFICATION_CLIENT_IDS`（通知JWSで許可するBundle ID / Services ID、カンマ区切り）
   - `APPLE_TEAM_ID`
   - `APPLE_KEY_ID`
   - `APPLE_PRIVATE_KEY`（`.p8`本文）
   - `APPLE_TOKEN_ENCRYPTION_KEY_ID`
   - `APPLE_TOKEN_ENCRYPTION_KEYS_JSON`（key IDごとの32-byte AES鍵）

   Supabaseが提供する `SUPABASE_URL`、`SUPABASE_ANON_KEY`、`SUPABASE_SERVICE_ROLE_KEY` もFunction環境で利用します。service role keyはクライアントへ配布しません。

7. `public.purge_expired_account_lifecycle_data()`、`public.purge_expired_apple_account_events()`、`public.purge_expired_content_reports()`、`public.purge_expired_group_invite_rate_limits()` を毎日service role相当で実行する運用ジョブを設定し、返却値が0になるまで有界バッチを繰り返し、失敗通知を付ける。通報記録の180日保持、削除tombstoneの90日保持、招待試行情報の24時間以内削除、バックアップ最大30日の実設定と法務ページの表現を一致させる。
8. `supabase test db` で `supabase/tests` のDBテストを実行したうえで、RLSのクロスユーザーテスト、同じrequest/intent IDの再送、500件超Storage削除、処理途中の通信切断からの復旧をステージングで確認する。
9. API gateway側でも `join_group_by_invite` の送信元IP単位レート制限を設定する。DB内では128-bitコード、UID単位15分12回、50人上限を強制済みだが、gateway制限も多層防御として有効にする。

## 3. Google設定

### バックアップ用Googleログイン

1. Google CloudのOAuth同意画面にアプリ名、問い合わせ先、本番ドメイン、プライバシーポリシー、利用規約を登録する。
2. Google OAuthクライアントの承認済みリダイレクトURIに、Supabase Dashboardが表示する `https://<PROJECT_REF>.supabase.co/auth/v1/callback` を完全一致で登録する。
3. Supabase Google providerへWeb Client IDとsecretを設定する。
4. テスト公開を終えて本番公開へ切り替え、必要なOAuth確認を完了する。「このアプリは確認されていません」が一般利用者に出ないことを確認する。
5. バックアップログインは最小の `openid email` を使用し、Google Calendar権限とは別の同意として扱う。

### Google Calendar連携

- Calendar連携はバックアップ用ログインとは別機能。現在のネイティブリリースでは未完成UIを非表示にし、Webでのみ提供する。
- Web Client IDの承認済みリダイレクトURIに、実際のWeb URLの `/auth` を登録する。
- Google API Services User Data Policy / Limited Useに沿い、`calendar.events.owned` と `calendar.calendars.readonly`、デモ動画、公開プライバシーポリシーをGoogle審査へ提出する。全カレンダーへの `calendar` スコープは要求しない。
- 接続・同期・切断を行い、Google側の元予定がRECOTOのアカウント削除で消えないことを確認する。

## 4. Apple Developer / Sign in with Apple

1. Apple DeveloperでApp ID `com.herac.recoto` を作成し、Sign in with Apple capabilityを有効にする。
2. Distribution証明書とProvisioning Profileを作り直し、XcodeのSigning Teamへ設定する。
3. AppleのSign in with Apple key（`.p8`）、Team ID、Key IDを作成し、上記Edge secretsへ設定する。
4. Supabase Apple providerのClient IDをBundle IDと一致させる。Web/AndroidでもApple OAuthを出す場合だけServices ID、Return URL、Web domainを追加する。
5. Hide My Emailで初回接続、再ログイン、再インストール復元、アカウント削除時のトークン失効を実機で確認する。
6. Apple private keyと暗号鍵のローテーション手順を記録する。古い暗号鍵は、そのkey IDを使う資格情報が無くなるまで削除しない。
7. Primary App IDのSign in with Apple「Server-to-Server Notification Endpoint」に `https://<PROJECT_REF>.supabase.co/functions/v1/apple-account-notification` を登録する。本番HTTPS/TLS 1.2以上の絶対URLとし、JWSの `aud` が `APPLE_NOTIFICATION_CLIENT_IDS` のいずれかと一致することを確認する。
8. TN3194に従い、実機でApple連携を解除した直後とバックグラウンド復帰後にクラウド同期が停止し、再ログイン案内になることを確認する。`getCredentialStateAsync` はSimulatorで常に失敗するため、この確認は必ず実機で行う。
9. ステージングで `consent-revoked` と `account-deleted`、同一JTIの重複配信、古いeventの再送を確認する。有効な通知でのみ対象UIDが凍結され、クラウドデータ、Storage、Authが削除され、重複は冪等、現在のApple credentialより古いeventはignoredになることを確認する。
10. `private.apple_credential_store_claims` で `exchange_started_at is not null` の行を監視する。これはAppleの一度限りcode交換後にFunctionが終了した可能性を示すため、TTL削除や自動再交換をしない。ユーザーがApple IDの「Apple IDを使用中のApp」からRECOTOの連携を停止したことを確認した後だけ、service roleで対象UID・subject hash・claim IDを完全一致させて `public.reconcile_apple_credential_store(..., true)` を実行する。その後に新しいApple再ログインを案内する。
11. 上記の不確定claimが残っていてもアプリ内アカウント削除は完了でき、`manualRevocationRequired=true` を回復receiptに残してDB・Storage・Auth・端末キャッシュが削除されることを通信切断テストで確認する。

## 5. 法務・問い合わせサイト

1. `legal-site/public` を公開HTTPSドメインへデプロイし、6ページ、404、リダイレクト、CSP等のレスポンスヘッダーを実URLで確認する。
2. 本番環境へ `EXPO_PUBLIC_LEGAL_BASE_URL=https://<LEGAL_DOMAIN>` を設定する。
3. 同じPrivacy URLとSupport URLをApp Store Connectへ登録し、Google OAuth同意画面の承認済みドメインにも追加する。
4. [要確認] `HERAC LLC` が実際の正式な運営者名か確認する。
5. [要確認] 日本の個人情報保護法上必要な事業者住所・代表者名を、プライバシーポリシーへ正確に追記する。架空の値は入れない。
6. [要確認] 災害復旧バックアップの実保持期間、通報対応の運用担当・受付手順、法務レビューを確定し、日英の表現を一致させる。

## 6. App Store Connect

- Privacy Policy URLとSupport URLを設定する。
- App Privacyは実装と一致させる。`User ID`、`Name`、`Email Address`、`Contacts`（グループのsocial graph）、`Customer Support`、`Coarse Location`、`Precise Location`、`Device ID`、`Other Diagnostic Data`、`Performance Data`、`Other Data Types`（暗号化Apple失効資格）、`Other User Content`、`Photos or Videos` を「Linked to User / App Functionality / Not used for tracking」として確認する。Supabaseログの実項目と保持期間を確認するまでは安全側に申告し、根拠なく減らさない。
- アプリ内にゲスト利用、同等に見つけやすいGoogle/Appleログイン、プライバシー/規約/問い合わせ、アカウント削除を表示する。
- 審査用に2ユーザー分のテスト手順、グループ参加コード、通報・ブロック、クラウド復元、削除の確認手順をReview Notesへ記載する。バックエンドは審査中も稼働させる。
- 取得権限は利用場面で要求する。通知は予定通知を初めて有効にした時、写真は写真を選んだ時だけ要求する。
- XcodeのPrivacy Reportと `ios/app/PrivacyInfo.xcprivacy`、第三者SDK manifests、App Privacy回答が一致することをArchiveで確認する。

## 7. 最終E2E

- ゲストで予定・記念日・スタンプ・旅行・旅程を作成できる。
- ゲスト→Google、ゲスト→Appleで同じデータが維持され、別端末/再インストールで復元できる。
- アカウントA→BでAのデータが一瞬も表示・送信されない。
- オフライン編集→再接続、同時編集、削除tombstone、画像失敗再送がデータ欠落なく完了する。
- グループ作成/参加/退出、通報、ブロック、所有者による除名・再参加防止を2アカウントで確認する。
- アカウント削除はGoogle/Apple/ゲストすべてで完了し、途中終了後も同じreceiptで再開できる。完了後はクラウド、Storage、端末キャッシュ、通知、認証情報が残らない。
- 日本語/英語、VoiceOver、Dynamic Type、狭い画面、ダークモード対象範囲を確認する。
- TestFlightでクラッシュ、リンク、OAuth戻り、バックグラウンド復帰を最終確認してから審査へ提出する。
