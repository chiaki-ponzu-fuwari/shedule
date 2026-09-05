# Recoto App Store 提出チェックリスト

最終更新: 2026-09-05
対象: iOS 1.0.0 / `com.herac.recoto`

> このファイルは提出1回ごとの証跡用です。外部認証情報、実機、本番サーバーでの確認が済むまではすべて未完了とします。詳細な本番構成手順は [`DEPLOY_CHECKLIST.md`](../../DEPLOY_CHECKLIST.md) を使います。

## 1. ソースとビルド

- [ ] 提出対象commit SHAとバージョン/Build番号を記録した。
- [ ] `npm ci`、`npm run verify`、`npm run check:legal`、`npm run check:edge`を新規checkoutで実行した。
- [ ] `npm audit --json`と`npm audit --omit=dev --json`の結果を保存し、本番依存の未対応Critical/Highを判定した。
- [ ] **Xcode 26** / **iOS 26 SDK**でRelease Archiveを作成した。
- [ ] Signing Team、Distribution証明書、Provisioning Profile、Sign in with Apple entitlementがArchiveと一致した。
- [ ] OrganizerのValidate Appを通過した。

## 2. Privacy・法務

- [ ] Archiveの**Privacy Report**を出力し、`ios/app/PrivacyInfo.xcprivacy`、第三者SDK manifest、App Privacy回答と照合した。
- [ ] App Store ConnectにPrivacy Policy URLとSupport URLを登録した。
- [ ] 公開HTTPSのprivacy / terms / support / deletion / community pagesを**携帯回線**で開き、CSP等のヘッダーも確認した。
- [ ] アプリ内「設定」の法務リンクが同じ本番URLを開く。
- [ ] `docs/app-store/app-privacy-answers.md`を実Archiveと一致する最終回答に更新した。
- [ ] 運営者の正式名称、住所、代表者名、保持期間、法務確認を確定した。
- [ ] **公開ブロッカー:** Supabaseログ、削除tombstone、通報、災害復旧バックアップの保持期間を本番で検証するまで法務サイトを公開しない。異なる場合は設定と日英ポリシーを先に一致させる。

## 3. Supabase・OAuth

- [ ] 本番DBをバックアップし、migrations `000`〜`009`とDBテストをステージング→本番の順に適用した。
- [ ] 9個のEdge Functionsと必要secretsを本番へ登録した。
- [ ] Supabase Anonymous / manual linking / Google / Apple providerを有効化した。
- [ ] Apple App ID、`.p8`、Server-to-Server Notification Endpoint、Google OAuth consent/redirect URIを本番値で確認した。
- [ ] 削除・Apple event・通報・招待rate limitの定期purgeと失敗通知を設定した。
- [ ] 審査中のバックエンド稼働と監視担当を確定した。

## 4. 審査用データ

- [ ] **2アカウント**の審査専用ユーザーA/Bを本番に用意した。
- [ ] 共有fixtureと分けた削除専用アカウントを本番に用意した。
- [ ] A/B/削除専用アカウントごとにGoogleまたはAppleのproviderと押すボタンを指定した。
- [ ] Aが所有し、Bが参加済みの無害なテストグループと共有予定を用意した。
- [ ] 最新の128-bit招待コードをReview Notesへ記載した。
- [ ] 審査資格情報をApp Store Connectのみに入力し、Git・ドキュメント・画面収録へ残していない。
- [ ] `docs/app-store/review-notes.md`はplaceholderのまま保ち、App Store Connectへ貼り付けたコピーだけを本番値へ置換した。

## 5. 実機E2E

- [ ] 新規インストールでゲスト予定・日記・スタンプ・写真・旅行・旅程を作成できる。
- [ ] ゲスト→Google、ゲスト→AppleでUIDとローカルデータを安全に引き継げる。
- [ ] 別端末と再インストール後に予定・画像・旅行を復元できる。
- [ ] 別々のクリーンインストール（2台、またはアプリデータを消去した端末）でA/Bを検証し、オフライン再送、同時編集、画像失敗、強制終了からの復旧で他UIDのデータを表示・送信しない。
- [ ] グループの作成/参加/退出、通報、ブロック、除名、再参加防止をA/Bで確認した。
- [ ] Google / Apple / ゲストのアカウント削除と途中終了からの再開を確認した。
- [ ] Apple連携解除とServer-to-Server通知で同期が停止し、端末データが適切に消去される。
- [ ] 通知は初回の予定通知操作時、写真は選択時だけ権限を要求する。
- [ ] 日本語/英語、VoiceOver、Dynamic Type、狭い画面、オフラインを実機で確認した。

## 6. TestFlightと提出

- [ ] **TestFlight**のクリーンインストールで起動、OAuth復帰、バックグラウンド復帰、削除、外部リンクを再確認した。
- [ ] App Store名「レコト｜共有カレンダー・予定表」と副題が実装・30文字制限・名称取得可否に適合する。
- [ ] J-PlatPatとApp Store Connectで名称を確認した。
- [ ] Review Notesの各導線を提出対象buildで通し、スクリーンショット/画面収録を保存した。
- [ ] バックエンド監視、通報受付、審査連絡の当番を確定した。
- [ ] 提出後、審査完了まで認証設定・テストデータ・審査中のバックエンド稼働を維持する。
