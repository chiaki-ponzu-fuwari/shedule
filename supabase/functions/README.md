# Recoto account Edge Functions

These functions are the server-only boundary for linking an existing account,
storing the Apple revocation credential, and deleting an account. They derive
the acting user from a verified Supabase access token and never trust a body
`userId`.

## Functions

- `start-account-merge`: creates a ten-minute, single-target guest merge intent.
- `complete-account-merge`: consumes the intent as the existing account, merges
  target-wins data, and removes the replaced anonymous Auth user last.
- `cancel-account-merge`: cancels an unused intent as its guest owner.
- `store-apple-token`: exchanges Apple's one-time authorization code and stores
  only an AES-GCM encrypted refresh token.
- `apple-credential-status`: returns only a subject-bound credential-presence
  boolean so an interrupted native Apple link can resume safely.
- `apple-account-notification`: verifies Apple's signed account event and
  idempotently freezes/deletes the exact subject-bound account.
- `start-account-deletion`: creates a short-lived deletion challenge bound to
  a client-generated recovery receipt.
- `delete-account`: requires a recently issued same-user session, freezes stale
  JWT writes, revokes available providers, removes private Storage objects,
  deletes database data, and deletes the Auth user last.
- `account-deletion-status`: uses the recovery receipt, rather than a deleted
  Auth session, to confirm or finish the final deletion receipt.

## Deployment requirements

1. Apply migrations `000` through `009` in order to a staging project. Migration
   `009` rotates every historical short group invite code, so notify existing
   group owners that previously shared links will stop working.
2. Configure the server-only secret names listed in `DEPLOY_CHECKLIST.md` as
   Supabase Edge Function secrets. `.env.example` intentionally contains only
   client-safe public values. Never use an `EXPO_PUBLIC_` prefix for
   service-role, Apple private, or encryption secrets.
3. Set `ALLOWED_WEB_ORIGINS` to exact HTTPS production origins. Keep localhost
   entries only in local/staging environments.
4. Keep Supabase JWT verification enabled for authenticated functions. The
   shared runtime performs a second `auth.getUser(token)` verification and all
   service RPCs remain granted only to `service_role`. The two public transport
   exceptions are `account-deletion-status` (a high-entropy recovery receipt
   after Auth deletion) and `apple-account-notification` (an Apple-signed JWS).
   Neither handler accepts a user ID, and their backing RPCs remain
   `service_role`-only.
5. Keep old entries in `APPLE_TOKEN_ENCRYPTION_KEYS_JSON` until every credential
   bearing that key ID has been deleted or re-encrypted. Switch only
   `APPLE_TOKEN_ENCRYPTION_KEY_ID` when rotating the active key.
6. Set `GOOGLE_OAUTH_CLIENT_IDS` to the comma-separated Google OAuth client IDs
   used by the released Web/iOS/Android account-login flows. `delete-account`
   accepts a freshly returned Google provider token only when tokeninfo matches
   both the user's Google subject and one of these audiences. Never persist or
   log that provider token.
7. Set `APPLE_NOTIFICATION_CLIENT_IDS` to every Bundle ID or Services ID whose
   exact `aud` is accepted. Register
   `https://<PROJECT_REF>.supabase.co/functions/v1/apple-account-notification`
   as the primary App ID's Apple server-to-server notification endpoint.
8. Monitor exchange-started rows in `private.apple_credential_store_claims`.
   They mark a possible Apple grant whose token response was lost before its
   encrypted database commit, so they intentionally never expire into another
   automatic code exchange. Account deletion may continue with a durable manual
   revocation flag. To keep the account instead, first confirm that the user has
   stopped using Recoto in their Apple ID settings, then call the service-only
   `reconcile_apple_credential_store` RPC with the exact UID, subject hash,
   claim ID, and `p_provider_revocation_confirmed = true`; only then ask the user
   for a fresh Apple authorization.

CI runs `deno check` for every entry point; keep that check required for merge.
Before production, run the SQL cross-user/RLS tests, invoke every function from
two staging users, interrupt each request after every durable phase, retry with
the same request/intent ID, and verify the final state. Deployment remains an
external release check when the local Supabase CLI is not installed.
