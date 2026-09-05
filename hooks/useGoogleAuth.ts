import { useCallback } from 'react';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { useGoogleAuthStore } from '../store/googleAuthStore';
import { Alert, Platform } from 'react-native';

WebBrowser.maybeCompleteAuthSession();

// Google Cloud Console で取得したiOS クライアントID
// ※ 実際の値はGoogle Cloud Consoleから取得して設定してください
const IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';
const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';

const DISCOVERY = {
  authorizationEndpoint: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenEndpoint: 'https://oauth2.googleapis.com/token',
  revocationEndpoint: 'https://oauth2.googleapis.com/revoke',
};

export function useGoogleAuth() {
  const signIn = useGoogleAuthStore((s) => s.signIn);
  const signOut = useGoogleAuthStore((s) => s.signOut);
  const isSignedIn = useGoogleAuthStore((s) => s.isSignedIn);

  const isWeb = Platform.OS === 'web';
  // Webはproxy認証が不安定になりやすいのでproxyなし、端末はproxyありで安定させる
  const useProxy = !isWeb;
  const redirectUri = AuthSession.makeRedirectUri({ scheme: 'scheduleshare', useProxy });
  const clientId = isWeb ? WEB_CLIENT_ID : (IOS_CLIENT_ID || WEB_CLIENT_ID);

  // Expo Goで ExpoCrypto が無い環境があり Code+PKCE が落ちるため、
  // まずは全環境で access_token を直接受け取る方式に統一して起動を安定させる。
  // （本番でrefresh tokenが必要なら開発ビルド＋Codeフローに戻す）
  const responseType = AuthSession.ResponseType.Token;

  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId,
      responseType,
      scopes: [
        'openid',
        'profile',
        'email',
        'https://www.googleapis.com/auth/calendar',
      ],
      redirectUri,
      extraParams: {
        // refresh_token を得やすくする（初回 or 明示同意時）
        access_type: 'offline',
        prompt: 'consent',
      },
    },
    DISCOVERY
  );

  const handleSignIn = useCallback(async () => {
    if (!IOS_CLIENT_ID && !WEB_CLIENT_ID) {
      Alert.alert(
        'Google連携の設定が必要です',
        'Google Cloud ConsoleでOAuthクライアントIDを取得し、設定してください。\n\n環境変数:\n- EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID\n- EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID\nを設定してください。',
        [{ text: 'OK' }]
      );
      return;
    }

    const result = await promptAsync({ useProxy });

    if (result?.type === 'success' && result.params.access_token) {
      const accessToken = result.params.access_token as string;
      const userInfo = await fetch(
        'https://www.googleapis.com/userinfo/v2/me',
        { headers: { Authorization: `Bearer ${accessToken}` } }
      ).then((r) => r.json());

      await signIn(
        userInfo.email ?? '',
        userInfo.name ?? '',
        userInfo.picture ?? null,
        accessToken,
        null
      );
      return;
    }
    if (result?.type === 'error') {
      Alert.alert('ログインエラー', result.error?.message ?? 'Googleログインに失敗しました。');
    } else if (result?.type === 'success') {
      Alert.alert('ログインに失敗しました', 'トークンが取得できませんでした。リダイレクトURIやクライアントIDを確認してください。');
    }
  }, [promptAsync, signIn, useProxy, clientId]);

  const handleSignOut = useCallback(async () => {
    await signOut();
  }, [signOut]);

  return { handleSignIn, handleSignOut, isSignedIn, request, redirectUri, useProxy, clientId };
}
