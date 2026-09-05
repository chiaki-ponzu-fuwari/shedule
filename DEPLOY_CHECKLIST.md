# リリース前チェック（3 項目・この順で）

## ① Supabase：本番 DB にマイグレーションを適用する

1. [Supabase Dashboard](https://supabase.com/dashboard) で**本番プロジェクト**を開く。
2. 左メニュー **SQL Editor** → New query。
3. 次のファイルを**番号順に**開き、**中身をすべてコピーして実行**する（各ファイルは「全体を一度に」実行）。
   - `supabase/migrations/001_auth_rls_rpc.sql`
   - `supabase/migrations/002_rls_no_recursion.sql`
   - `supabase/migrations/003_security_hardening.sql`
   - `supabase/migrations/004_group_owner_limit.sql`（オーナー作成グループ数の上限 10）
4. 左メニュー **Authentication** → **Providers** → **Anonymous** を **Enabled** にする（未設定なら）。
5. 動作確認（本番アプリの anon キーで）:
   - 起動後にグループ作成・参加・退出ができること
   - 既に 001 のみ入っている環境でも、002→003 はそのまま続けて実行してよい（`IF EXISTS` 系で上書き）

**よくある失敗**: ステージング用と本番用でプロジェクトが別なら、**両方**に同じ SQL を当てる。

---

## ② Google Cloud：リダイレクト URI と secret の扱い

1. [Google Cloud Console](https://console.cloud.google.com/) → **API とサービス** → **認証情報** → 該当する **OAuth 2.0 クライアント ID** を開く。
2. **承認済みのリダイレクト URI** に、次を**必要なものだけ**追加する（本番・開発用を分ける）。
   - **Web 用クライアント**（`EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID`）:
     - ローカル例: `http://localhost:8081/auth` または `http://localhost:19006/auth`
       （`expo start --web` 実行時にブラウザの URL バーで **実際のポートとパス** を確認して一致させる）
     - 本番: `https://（あなたの公開ドメイン）/auth`
   - **iOS 用**（ネイティブ・Expo 開発ビルド）では、Google の「iOS」タイプのクライアントは **バンドル ID** ベース。リダイレクト URI リストは Web クライアント側が主。
   - Expo の **scheme** は `app.json` の `scheme`（このプロジェクトは `recoto`）。開発時に Expo が出す **カスタムスキーム URI** を使う場合は、Google の「ウェブ」クライアントに
     `https://auth.expo.io/@YOUR_EXPO_ACCOUNT/recoto` のような URI が必要になることがある（Expo Go / proxy 利用時）。**今のコードは Web で `/auth` を使用**しているため、まずは **localhost の `/auth`** と **本番 URL** を優先。
3. **クライアントシークレット**は「公開クライアント」ではアプリに埋め込まない。`.env` にも **入れない**（`EXPO_PUBLIC_` には載せない）。
4. 保存後、アプリを再起動して Google ログインを試す。

詳細な URI の一覧は `.env.example` のコメントも参照。

---

## ③ 依存関係：`npm audit` と更新方針

プロジェクト直下で:

```bash
npm run audit
npm run audit:fix
```

- 最初の `audit:fix` で**ロックファイルが更新**され、解消できるものは解消される。
- 残りが **Expo / `@expo/cli` / `tar` などに紐づく high** の場合、`npm audit fix --force` は **Expo のメジャーアップ**（例: 52 → 55）を引き起こすため、**そのまま実行しない**。次のどちらかで対応する:
  1. **リリース直前は現状維持**し、監査レポートだけ記録する（開発用 CLI 鎖の脆弱性がランタイムに直撃しないケースも多い）。
  2. **別ブランチ**で [Expo SDK アップグレード手順](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/)に従い、`npx expo install expo@^次のSDK` → 動作確認 → マージ。
- 修正後は `npm run start` と実機／Web で一通り動作確認する。

---

以上を終えたら、本番用 `.env`（**Git にコミットしない**）に `EXPO_PUBLIC_*` のみが入っていることを再確認してください。
