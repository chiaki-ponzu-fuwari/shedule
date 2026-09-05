# Recoto App Privacy 回答案

最終更新: 2026-09-05
対象: iOS 1.0.0 / Bundle ID `com.herac.recoto`

> これはApp Store Connect入力用の作業表です。入力済みであることの証明ではありません。本番ArchiveのPrivacy Report、実通信、Supabase・Apple・Googleの本番設定と照合するまでは「未確認」です。

## 全カテゴリ共通の回答

- Linked to User: **Yes / Linked to User**
- Purpose: **App Functionality**
- Tracking: **No / Not used for tracking**
- 広告、第三者横断トラッキング、データ販売: 実装なし
- 分析・広告SDK: 実装なし

ゲスト利用でもSupabaseの匿名UIDに関連付くグループデータがあるため、「Not Linked to User」にはしません。

## 申告する収集データ

| App Store Connectの分類 | Recotoでの内容 | 収集条件 | 回答 |
| --- | --- | --- | --- |
| Identifiers > **User ID** | Supabase Auth UID、匿名UID、Google/Appleとの本人識別結果 | グループまたはクラウド保存の利用時 | Linked to User / App Functionality / Not used for tracking |
| Contact Info > **Name** | グループ内の表示名、ユーザーが予定・記念日等へ入力した名前 | 入力または共有した場合 | Linked to User / App Functionality / Not used for tracking |
| Contact Info > **Email Address** | Google/Apple認証が提供するメールアドレス、Appleの非公開リレーアドレス | クラウド保存用アカウントを接続した場合 | Linked to User / App Functionality / Not used for tracking |
| **Contacts** | アドレス帳ではなく、グループ参加関係、共有相手、ブロック・除名関係というsocial graph | グループを利用した場合 | Linked to User / App Functionality / Not used for tracking |
| User Content > **Customer Support** | 問い合わせメールに利用者が記載する端末・OS・アプリ版、発生画面・操作・日時・エラー文、任意のスクリーンショット | 利用者がメールサポートへ連絡した場合 | Linked to User / App Functionality / Not used for tracking |
| Location > **Coarse Location** | Supabase/Cloudflareの運用ログに含まれ得るIP由来の国・地域等。現在地権限は使わない | Supabase API/Auth/Storage/Edge通信時 | Linked to User / App Functionality / Not used for tracking |
| Location > **Precise Location** | Supabase/Cloudflareの運用ログに含まれ得るIP由来の緯度・経度。端末の現在地権限やGPSは使わない | Supabase API/Auth/Storage/Edge通信時 | Linked to User / App Functionality / Not used for tracking |
| Identifiers > **Device ID** | 広告IDやIDFVではなく、認証・不正防止・rate limitに使われ得るIP/User-Agent等のリクエスト元識別情報を安全側に分類 | Supabase通信時 | Linked to User / App Functionality / Not used for tracking |
| Diagnostics > **Other Diagnostic Data** | リクエスト日時、path、status、error種別、User-Agent等のSupabase運用ログ | APIの安定運用、セキュリティ、障害調査のため | Linked to User / App Functionality / Not used for tracking |
| Diagnostics > **Performance Data** | TCP往復時間、proxy latency、origin response time等のSupabase/Cloudflare運用ログ | 性能監視と障害調査のため | Linked to User / App Functionality / Not used for tracking |
| **Other Data Types** | Apple連携の削除時失効に必要な暗号化refresh tokenと資格情報の世代メタデータ | Appleでクラウド保存を接続した場合 | Linked to User / App Functionality / Not used for tracking |
| User Content > **Other User Content** | 予定、時刻、日記・メモ、繰り返し予定、記念日・誕生日、スタンプ、旅行・旅程、出発・到着タイムゾーン、場所、予約番号、URL、グループ設定・共有内容、通報内容 | ユーザーが作成・共有・バックアップした場合 | Linked to User / App Functionality / Not used for tracking |
| User Content > **Photos or Videos** | ユーザーが選択した予定・日記・画像スタンプ。クラウド用はJPEGに処理 | 画像を選択し、クラウド保存した場合 | Linked to User / App Functionality / Not used for tracking |

## 「収集なし」の予定

現行iOS実装では、次のデータをサーバーへ収集する機能を確認していません。本番ArchiveのSDK通信を確認してから最終回答します。

- Purchases、Financial Info、Health & Fitness
- Sensitive Info
- Browsing History、Search History
- Usage Data、Crash Data

## 処理先と保持

- **Supabase**: Auth、Postgres、private Storage、Edge Functions。RLSでUID単位に制限します。
- **Google / Apple**: オプションのバックアップ用本人確認。Googleは `openid email`、Appleは追加profile scopeを要求しません。
- **Expo Notifications**: iOS版はローカル通知のみを使い、Expo Push Tokenを取得・送信しません。
- **Google Calendar**: バックアップ用Googleログインとは別機能です。現行iOS版では連携UIを表示しません。
- アカウント削除でRecotoのAuth、DB、Storage、端末キャッシュを削除します。削除tombstoneは90日、通報は180日、障害復旧バックアップは最大30日とする運用設定を、公開前に実環境で照合します。

## 提出前の未確認項目

- [ ] Xcode Organizerから本番ArchiveのPrivacy Reportを出力し、第三者SDKのmanifestと答えが一致する。
- [ ] App Store ConnectのApp Privacy画面で、上記13分類を同じ回答で入力する。
- [ ] 本番SupabaseのLogs ExplorerでAPI/Auth/Storage/Edgeの実ログとプラン依存の保持期間を確認し、Coarse Location / Precise Location / Device ID / Other Diagnostic Data / Performance Dataの説明を更新する。申告を減らすのは、対象データがリクエスト処理後に保持されないと確認できた場合だけとする。
- [ ] TestFlightを実機で操作し、記載外の分析・クラッシュ・プッシュ通信がないことを確認する。
- [ ] Privacy Policy URL、Support URL、アプリ内リンクが同じHTTPSページを指す。
- [ ] 機能、SDK、保持期間を変更した場合は、回答・Privacy Manifest・ポリシーを同時更新する。

## 根拠

- [Apple: App privacy details on the App Store](https://developer.apple.com/app-store/app-privacy-details/)
- [Apple: NSPrivacyCollectedDataType](https://developer.apple.com/documentation/bundleresources/app-privacy-configuration/nsprivacycollecteddatatypes/nsprivacycollecteddatatype)
- [Supabase: Logging](https://supabase.com/docs/guides/monitoring-and-debugging/logs)
- [Supabase: Log field reference](https://supabase.com/docs/guides/observability/log-field-reference)
