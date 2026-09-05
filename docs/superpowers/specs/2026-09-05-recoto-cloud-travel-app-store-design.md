# レコト：アカウント保存・旅行・App Store 公開設計

- 作成日: 2026-09-05
- 状態: 2026-09-05 ユーザー承認済み（外部コンソール値・法務最終確認はリリース前ゲート）
- 対象リポジトリ: `/Users/chiaki/Desktop/スケジュール共有アプリ`
- 運営者: HERAC LLC
- 問い合わせ先: `herac.7.app@gmail.com`

## 1. 目的と初回リリース範囲

既存のカレンダー、スタンプ、記念日、日記、グループ予定共有を維持しながら、次を実現する。

1. ゲストのまま主要機能を利用できる。
2. Google または Apple を「データ保存用アカウント」として接続すると、再インストールや端末変更後も個人データを復元できる。
3. カレンダーとグループの間に「旅行」タブを追加し、旅行期間と旅程を簡単に登録できる。
4. App Store 審査に必要なアカウント削除、プライバシー表示、権限要求、Sign in with Apple、レビュー用導線を備える。

初回リリースは日本の App Store を対象とする。アプリ UI と法的ページは日本語・英語を用意し、将来の配信地域追加を妨げない。初回は無料、広告・行動追跡・アプリ内課金・旅行のグループ共有を含めない。

## 2. 名称と識別子

### ユーザー向け名称

- ブランド名: **レコト**
- ローマ字表記: **RECOTO**
- 意味: `Record` と「日々のこと」を組み合わせた造語
- ブランドコピー: **予定も思い出も、これひとつ。**
- App Store 名: **レコト｜共有カレンダー・予定表**
- App Store 副題: **家族・カップルのシフトと旅程をかんたん管理**

App Store のキーワード欄では、名称・副題と重複しない「スケジュール、日記、記念日、誕生日、スタンプ、手帳、旅行」等を、実装済み機能だけに限定して使用する。公開前に App Store Connect の名称取得可否と J-PlatPat 第9類・第42類を確認する。

### 技術識別子

- Expo `name`: `レコト`
- Expo `slug`: `recoto`
- iOS bundle identifier / Android package: `com.herac.recoto`
- URL scheme: `recoto`

現在の `com.scheduleshare.app`、Xcode 側の `org.name.app`、OAuth リダイレクト設定は公開前に新識別子へ統一する。アプリは未公開のため、長期的に変更できない bundle identifier をブランドに合わせて今変更する。既存の Google Calendar OAuth クライアントを流用できない場合は、同じ Google Cloud プロジェクト内に新しい iOS クライアントを追加する。

## 3. ナビゲーションと旅行体験

タブ順は次の4つとする。

1. カレンダー
2. 旅行
3. グループ
4. 設定

### 旅行一覧

- 進行中、予定、過去の順で旅行カードを表示する。
- 空状態では「旅行を追加」ボタンと、登録できる内容の短い説明を表示する。
- 旅行カードにはタイトル、期間、色、開始・終了の移動アイコン、次の旅程を表示する。

### 旅行の基本情報

- 必須: タイトル、開始日、終了日
- 任意: 色、開始アイコン、終了アイコン、メモ
- 色は視認性を確認済みのプリセットから選ぶ。
- アイコンは「なし・飛行機・電車・車・バス・船・徒歩」から、開始側と終了側を別々に選べる。
- 旅行期間は開始日・終了日を含むローカル日付として保存し、タイムゾーン移動で日付がずれないようにする。

### 旅程

旅程項目の種類は「フライト・電車・ホテル・移動・予定・食事・メモ」。項目には日付、開始／終了時刻、出発地、到着地、施設名、予約番号、URL、メモを必要な分だけ入力できる。入力項目は種類に応じて絞り、詳細フォームを最初からすべて見せない。

時刻付き項目は UTC と出発地／到着地の IANA timezone を保持する。終日項目は時刻を持たない。URL は `https` を標準とし、危険な scheme は開かない。

### 月カレンダー上の表示

- 旅行ラインは日付数字のすぐ上に細く表示する。
- 開始日・終了日は、従来の丸点と同程度の大きさで選択アイコンを表示する。
- 誕生日・記念日マークは日付周辺、通常予定の帯は日付下部に残し、旅行ラインと重ねない。
- 週をまたぐ旅行は週ごとに連続線として描く。
- 同期間の旅行は2段まで表示し、3件目以降は小さな `+N` で示す。
- 旅行カラーは一覧・詳細・カレンダーで同じ色を使う。

初回リリースでは旅行は個人データとする。グループへの旅行共有は、個人保存・復元と権限モデルが安定した後の別機能として設計する。

## 4. ゲスト、ログイン、Google Calendar の分離

### 状態モデル

アプリ状態は次のように明示する。

- `hydrating`: 端末キャッシュの復元中
- `guest-local`: 個人機能を端末だけで利用中
- `guest-connected`: グループ機能用の匿名 Supabase セッションあり
- `account-connected`: Google または Apple identity が紐づき、クラウド保存中
- `offline`: 端末保存は継続し、クラウド更新は待機中
- `deletion-pending`: 削除処理中または再試行待ち

Supabase やネットワークに接続できなくても、カレンダー・旅行・日記は起動して利用できる。グループまたはアカウント機能を初めて使う時だけ、必要なら匿名セッションを作る。現在のように匿名認証エラーでアプリ全体を停止しない。

### データ保存用アカウント

設定上部に「データ保存用アカウント」カードを置く。

- ゲスト時: 端末故障・再インストールでは復元できないことを短く表示し、「Googleで保存」「Appleで保存」を表示する。
- 接続時: プロバイダー、メールまたは Apple の非公開メール、同期状態、最終同期時刻を表示する。
- 「ログアウト」は端末内のそのアカウント用キャッシュと認証情報だけを消し、クラウドデータは残す。
- 「アカウントとデータを削除」は別項目として、対象を説明してから実行する。

iOS では Google と Sign in with Apple を同程度に見つけやすく表示する。Apple ボタンは公式スタイルを使う。ネイティブの認証情報は SecureStore に保存する。

### 匿名ユーザーからの昇格

新しい Google／Apple identity を接続する場合は、Supabase manual identity linking を使って現在の匿名 UID を維持する。これにより、グループ所属や既存データの所有者を変えずに正式アカウントへ昇格できる。

すでに別 UID に紐づく identity へログインする場合は、単純な `linkIdentity` やメール一致で統合しない。匿名セッションを失う前に `start-account-merge` Edge Function で10分有効・1回限りの merge intent を作り、OAuth後の既存アカウントセッションから `complete-account-merge` を呼ぶ。サーバーは intent に記録した移行元 UID、ハッシュ化したnonce、移行先 JWT を照合する。処理順は次の通り。

1. ローカルのゲストデータを暗号学的乱数 ID 付きの移行スナップショットへ退避する。
2. OAuth で既存アカウント本人を確認する。
3. Edge Function が匿名セッションと既存アカウントの両方の証明を検証する。
4. グループ所属、所有権、共有行を1トランザクションで既存 UID へ移す。
5. 個人データはリモートを優先し、競合しないゲスト項目だけを追加する。
6. 統合結果を再取得・検証してから匿名アカウントを削除する。

途中で失敗した場合は匿名アカウントを消さず、移行スナップショットを保持して再試行できるようにする。

Sign in with Apple が初めて返す authorization code は直ちに専用 Edge Function へ送り、Apple client secret で refresh token に交換する。refresh token は private schema に暗号化して保存し、クライアントへ返さない。用途はアカウント削除時のApple token失効に限定する。

### Google Calendar 連携

「データ保存用Googleアカウント」と「Googleカレンダー連携」は別カード、別同意、別トークンとする。

- 保存用ログイン: `openid email profile` の最小 scope
- Calendar 連携: ユーザーが明示的に接続した時だけ Calendar scope を要求
- Calendar token: iOS/Android は SecureStore、Web は sessionStorage に保存
- Calendar token は個人バックアップには含めず、再インストール後は再接続してもらう
- 既に取り込んだ予定データはクラウドバックアップ対象に含める

## 5. クラウドデータとオフライン同期

### 基本方針

アカウント接続後は Supabase を正本、端末をユーザー別のオフラインキャッシュとする。巨大な1行 JSON を上書きせず、変更単位で保存する。

主要テーブルは次の通り。

- `profiles`: 表示名、locale、同意バージョン
- `personal_calendar_entries`: `user_id + entry_date`、日単位 payload
- `personal_special_dates`: 誕生日、記念日、その他
- `personal_preferences`: 週開始曜日等
- `personal_stamps`: カスタムスタンプと表示設定
- `trips`: 旅行基本情報、色、期間、開始・終了アイコン
- `trip_items`: 旅程項目、時刻、timezone、URL、並び順
- `account_deletion_requests`: 削除状態と再試行情報
- `user_blocks`: ブロック関係
- `content_reports`: 通報と対応状態

同期対象の各行に `id`、`user_id`、`schema_version`、`revision`、`updated_at`、`deleted_at` を持たせる。削除 tombstone は payload を空にして90日保持する。90日より長く同期していない端末は、ローカル変更を送る前に全量再取得することで削除済みデータの復活を防ぐ。

### 端末キャッシュ

現在の共通キー `calendar-storage` 等をそのまま使わず、`guest:<installationId>` または `user:<authUid>` を含む名前空間へ移行する。別アカウントへ切り替える前に現在のメモリ状態を破棄し、対象 UID のリモート取得が終わるまで別ユーザーの内容を表示しない。

端末には永続 outbox を置き、各変更へ mutation ID を付ける。同じ mutation の再送は冪等に処理する。UI は「端末に保存済み」「クラウド同期待ち」「同期済み」「要再ログイン」「競合を退避済み」を区別する。

### 初回移行と競合

1. Zustand の hydration と認証復元が完了するまで移行を始めない。
2. 旧ストレージを読み取り専用バックアップへ複製する。
3. リモートを先に取得する。
4. リモートに存在しないローカル項目だけ batch upsert する。
5. 同じ ID／日付に双方の変更がある場合はリモートを採用し、ローカル版を「移行バックアップ」に残す。
6. 再取得して件数と revision を検証してから、移行済みフラグを設定する。

移行は再実行しても重複しない。未公開の旧 `user_...` 開発データは、本番 migration 前にエクスポートして現在の Auth UID へ手動で割り当て、DB 列を UUID に統一する。

### クラウドへ送らない値

- 端末通知の `notificationId`
- Google 同期の端末内 fingerprint
- `file://` 等のローカル URI
- OAuth access token / refresh token
- 一時 UI 状態

写真と画像スタンプは EXIF を削除・圧縮し、private Storage の `user_id/...` 配下へ置く。DB には object key のみ保存し、署名付き URL を短時間発行する。復元先端末では object key から取得し、通知 ID は新しく発行する。

## 6. データベース権限とセキュリティ

公開 schema の全テーブルで RLS を有効化し、不要な `anon` / `authenticated` 権限を revoke する。個人テーブルは `(select auth.uid()) = user_id` を基本とし、RLS で使う列へ索引を置く。

`service_role`、Apple `.p8`、OAuth client secret は Edge Function secrets だけに置き、クライアントや `EXPO_PUBLIC_*` へ含めない。`SECURITY DEFINER` RPC は `search_path = ''`、完全修飾名、PUBLIC からの revoke を必須とする。

現在の `groups_update_member` のような全列更新を廃止し、グループ名・メモ・所有権等は許可操作ごとの RPC にする。招待コードは十分なエントロピーを持たせ、作成・参加・試行へ rate limit を設ける。

匿名ユーザーも Postgres 上では `authenticated` role になるため、永続アカウントだけに許す操作では JWT の `is_anonymous` を restrictive policy で確認する。匿名作成には rate limit と bot 対策を適用し、長期間未使用で所有データのない匿名アカウントだけを定期削除する。

## 7. アカウントとデータの削除

設定に、ログアウトとは明確に分けた「アカウントとデータを削除」を常設する。Google／Appleユーザーは同じ provider で本人確認をやり直す。ゲストは有効な匿名セッションと二段階確認を用いる。

クライアントは JWT 付きで `delete-account` Edge Function を呼ぶ。Function は body の `user_id` を信用せず、検証済み JWT から対象 UID を決める。

削除順は次の通り。

1. `deletion_pending` を作り restrictive RLS で新規変更を凍結する。
2. Apple の token がある場合は Apple 側で失効する。Google Calendar token も失効／連携解除する。
3. Storage API で UID 配下の写真・画像を削除する。
4. 1トランザクションの管理 RPC で個人データ、共有予定・投稿、membership を削除する。
5. 他メンバーがいる所有グループは最古の残存メンバーへ所有権を移し、単独グループは削除する。グループ共有メモはグループ所有として残す。
6. `auth.admin.deleteUser(uid, false)` を最後に実行する。
7. 成功後に SecureStore、ユーザー別キャッシュ、outbox、通知を消す。

途中失敗時は `deletion_pending` のままアクセスを止め、冪等に再試行する。削除後の古い JWT が期限まで残る可能性があるため、restrictive RLS と session 検証でアクセスを拒否する。削除直後に新しい匿名アカウントを自動作成せず、完了画面からユーザーが「ゲストで再開」を選んだ時だけ作る。

## 8. グループ共有と UGC 対策

招待制グループでも文章・予定・写真を共有できるため、初回公開までに次を用意する。

- グループ退出
- メンバーをブロックし、その人の共有内容を非表示にする機能
- コンテンツ／メンバーの通報
- 所有者によるメンバー削除と再参加禁止
- 文字数、URL scheme、明白な禁止語のサーバー検証
- コミュニティガイドラインと公開問い合わせ先
- 通報の受付状態を記録し、HERAC LLC が対応できる管理手順

通報データは不正対応のため180日保持し、その後削除する。アカウント削除時は通報本文中の不要な個人識別子を匿名化する。

本番DBのライブデータは、アカウント削除完了表示を出す前に削除する。削除処理の監査記録はコンテンツを含めず、不可逆化した識別子と完了日時だけを180日保持する。production のバックアップ保持は最大30日となる構成を公開前の条件とし、災害復旧以外には利用しない。所有データやグループ所属のない未使用匿名アカウントは30日後に清掃する。

## 9. 設定画面と法的ページ

設定画面は次の順に整理する。

1. プロフィール
2. データ保存用アカウント
3. Googleカレンダー連携
4. カレンダー・スタンプ・記念日設定
5. サポート・法的情報
6. 危険な操作（ログアウト、データ削除）

「サポート・法的情報」には次の認証不要 HTTPS ページへのリンクを置く。

- `/privacy.html`: プライバシーポリシー
- `/terms.html`: 利用規約
- `/support.html`: FAQ と問い合わせ
- `/delete-account.html`: 削除対象と操作手順
- `/community-guidelines.html`: 禁止行為、通報、ブロック

ページは日本語・英語を同一サイトで提供し、運営者 `HERAC LLC` と `herac.7.app@gmail.com` を記載する。専用の Firebase Hosting site を作り、アプリには `EXPO_PUBLIC_LEGAL_BASE_URL` を設定する。本番ビルドは URL 未設定、HTTP、リンク切れのいずれかで検証失敗にする。

プライバシーポリシーには、認証情報、予定、日記、記念日、旅行・旅程、URL、写真、スタンプ、グループ共有、Google Calendar、通知、外部委託先、国外処理、保持・削除、権限撤回を実装どおり記載する。Google Calendar は Limited Use を独立節で説明する。

初回リリースでは広告・第三者横断トラッキング・分析 SDK を導入しないため ATT を表示しない。法的文書は審査要件を満たすための実装文書であり、法的助言の代替ではない。公開前に日本法を扱う専門家へ最終確認を依頼する。

## 10. 権限と Privacy Manifest

- 通知: 起動直後には要求せず、ユーザーが初めて予定通知を有効にした時に説明してから要求する。拒否後も他機能を使える。
- 写真: system picker を優先し、選択だけに不要な全ライブラリ権限を要求しない。必要な場合は用途を具体的に記載する。
- Apple Sign-In: `expo-apple-authentication`、`ios.usesAppleSignIn`、entitlement、Apple Developer App ID を揃える。
- Privacy Manifest: アプリ所有の `PrivacyInfo.xcprivacy` を追加し、Required Reason API、収集データ、tracking=false を実装と一致させる。
- 第三者 SDK: Release archive 内の各 SDK manifest と署名を確認する。
- App Privacy: Auth ID、メール、予定・日記・旅程・写真等のユーザーコンテンツを、実際の関連付けと利用目的に合わせて回答する。

通知アイコン、App Icon、写真 purpose string、iOS entitlement、bundle identifier を Archive 前に検証する。

## 11. エラー処理

- ローカル書き込み成功・クラウド失敗: 編集を失わず「同期待ち」と表示し、指数バックオフで再試行する。
- セッション失効: ローカル閲覧を維持し、「再ログインが必要」と表示する。別 UID のキャッシュへ切り替えない。
- 画像失敗: 本文を先に保存し、画像だけ再送できる。未参照オブジェクトは定期清掃する。
- 競合: remote wins とし、失われるローカル版を移行バックアップへ保存してユーザーに通知する。
- 旅行 timezone 不明: ローカル timezone を候補表示し、時刻付き旅程では確認を求める。
- OAuth キャンセル: エラー扱いにせず元画面へ戻す。
- 削除処理失敗: アクセス凍結を維持し、状態と再試行ボタン、問い合わせ先を表示する。
- Supabase 障害: 個人機能は継続し、グループ・同期だけを一時停止する。

技術詳細や秘密情報を本番 UI・ログへ表示しない。ユーザー向けメッセージには「何が保存済みか」「何を再試行すべきか」を明示する。

## 12. テストと受入基準

### 自動検証

- `typecheck`: TypeScript エラー0件。既存 `useProxy` 4件を基準として放置しない。
- `test`: `jest-expo` と React Native Testing Library を導入する。
- `verify`: typecheck、unit test、設定・法的リンク・Privacy Manifest の静的検査をまとめる。

ユニットテスト対象:

- 繰り返し予定の月末・うるう年・冪等適用
- time slot と月表示 note item の同期
- 旅行期間、週またぎ、timezone、複数旅行表示
- クラウド payload から token、通知 ID、ローカル URI を除外
- 初回移行、remote-wins 競合、移行バックアップ
- outbox 再送、mutation 冪等性、tombstone
- 匿名から新規 identity への UID 維持
- 既存 identity 統合の中断・再試行
- アカウント切替時のキャッシュ分離
- Google Calendar の重複、更新、削除、401、無効 sync token

### Supabase staging 統合テスト

- ユーザーAはユーザーBの個人行・Storageを読み書きできない。
- 非メンバーはグループを読めず、メンバーは共有許可された項目だけ読める。
- 匿名からGoogle／Appleへ昇格してもUIDとグループ所属が維持される。
- 既存アカウント統合は二重登録せず、失敗後に再試行できる。
- 端末Aの変更が端末Bへ反映され、再インストール後に復元される。
- オフライン編集は復帰後1回だけ反映され、削除項目は復活しない。
- 削除後は Auth、DB、Storage に孤児データがなく、グループ所有権が規則どおり処理される。

### 実機・TestFlight

- Expo Go ではなく Release 相当の standalone build を使用する。
- 小型 iPhone と現行大型 iPhone で、クリーンインストール、更新、削除後再インストールを確認する。
- ゲスト作成 → Google／Apple接続 → 別端末復元 → ログアウト → 再ログイン → 削除を一周する。
- 写真の許可／限定／拒否、通知の許可／拒否、OAuthキャンセル、オフライン復帰、招待リンクを確認する。
- Dynamic Type 最大、VoiceOver、キーボード、安全領域で主要操作を完了できる。
- テスト文言、リンク切れ、クラッシュを0件にする。

### App Review 提出物

- ゲストでカレンダー・旅行・日記を試す手順
- Google／Appleログインと復元手順
- 有効期限のないレビュー用グループ招待コードとテストメンバー
- Google Calendar 連携が保存用ログインとは別機能である説明
- 設定からのアカウント削除手順
- 稼働中の production backend と公開法的ページ
- 実際の画面だけを使ったスクリーンショット

## 13. 作業の分割と実装順

この設計全体を一度に変更すると、認証・同期・旅行UI・審査対応の障害原因を切り分けにくい。以下の4作業へ分け、それぞれに実装計画、テスト、レビュー、完了判定を設ける。

### A. 公開基盤と安全なゲスト起動

1. 既存変更をスナップショットし、テスト基盤と typecheck を整える。
2. レコトへの名称・bundle identifier・URL scheme の統一を行う。
3. 起動と認証を状態機械化し、Supabase障害中もゲストの個人機能を利用可能にする。
4. 通知・写真権限を文脈内要求へ移し、Privacy Manifest と iOS 設定の土台を追加する。

### B. アカウント、クラウド保存、削除

1. Supabase schema、RLS、Storage、outbox、ユーザー別キャッシュ、初回移行を実装する。
2. Google／Apple保存用ログインと既存アカウント統合を実装する。
3. ログアウト、クラウド復元、アカウント削除を実装する。
4. stagingでユーザー分離、再インストール復元、削除を検証する。

### C. 旅行

1. 旅行テーブルと同期変換を実装する。
2. 旅行タブ、旅程入力、URL、安全なtimezone処理を実装する。
3. 承認済みの月カレンダーライン、色、極小の移動アイコンを実装する。
4. オフライン、復元、複数旅行、通知を検証する。

### D. UGC、法的ページ、App Store 提出

1. UGC通報・ブロック・所有者モデレーションを実装する。
2. 設定内法的導線と公開HTTPSページを実装する。
3. Privacy Manifest、App Privacy回答、OAuth同意画面、実際の通信を一致させる。
4. staging、実機、TestFlight、App Review用シナリオを完走する。

最初に A の実装計画を作り、完了後に B、C、D を順番に扱う。各作業で自動テストを先に追加し、既存の未コミット変更を無関係に戻したり上書きしたりしない。

## 14. 参考資料

- [Apple App Review Guidelines](https://developer.apple.com/app-store/review/guidelines/)
- [Apple: Offering account deletion in your app](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
- [Apple: App Store search](https://developer.apple.com/app-store/search/)
- [Apple: Creating your product page](https://developer.apple.com/app-store/product-page/)
- [Apple: Privacy manifest files](https://developer.apple.com/documentation/bundleresources/privacy-manifest-files)
- [Supabase: Anonymous Sign-Ins](https://supabase.com/docs/guides/auth/auth-anonymous)
- [Supabase: Identity Linking](https://supabase.com/docs/guides/auth/auth-identity-linking)
- [Supabase: Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase: Storage Access Control](https://supabase.com/docs/guides/storage/security/access-control)
- [Supabase: User Management](https://supabase.com/docs/guides/auth/managing-user-data)
- [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy)
