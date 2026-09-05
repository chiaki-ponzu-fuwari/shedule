import { useCallback, useEffect, useRef } from 'react';
import * as WebBrowser from 'expo-web-browser';
import * as AuthSession from 'expo-auth-session';
import { useGoogleAuthStore } from '../store/googleAuthStore';
import { Alert, Platform } from 'react-native';

WebBrowser.maybeCompleteAuthSession();

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

  // Webは implicit flow を使うため PKCE を無効化し、redirectUri は明示的にパスを付ける
  const redirectUri = AuthSession.makeRedirectUri({ path: 'auth' });
  const clientId = WEB_CLIENT_ID;

  // Webは client_secret を置けないので token を直接受け取る方式
  const [request, response, promptAsync] = AuthSession.useAuthRequest(
    {
      clientId,
      responseType: AuthSession.ResponseType.Token,
      usePKCE: false,
      scopes: [
        'openid',
        'profile',
        'email',
        'https://www.googleapis.com/auth/calendar',
      ],
      redirectUri,
      extraParams: {
        prompt: 'consent',
      },
    },
    DISCOVERY
  );

  const webAlert = (title: string, body?: string) => {
    if (Platform.OS === 'web' && typeof globalThis !== 'undefined') {
      const w = globalThis as unknown as { alert?: (m?: string) => void };
      w.alert?.(body ? `${title}\n\n${body}` : title);
    } else {
      Alert.alert(title, body ?? '');
    }
  };

  const handledTokenRef = useRef<string | null>(null);

  const finishWithAccessToken = useCallback(
    async (accessToken: string) => {
      if (handledTokenRef.current === accessToken) return;
      handledTokenRef.current = accessToken;
      try {
        const userInfo = await fetch('https://www.googleapis.com/userinfo/v2/me', {
          headers: { Authorization: `Bearer ${accessToken}` },
        }).then((r) => r.json());

        await signIn(
          userInfo.email ?? '',
          userInfo.name ?? '',
          userInfo.picture ?? null,
          accessToken,
          null
        );
      } catch (e) {
        handledTokenRef.current = null;
        throw e;
      }
    },
    [signIn]
  );

  // promptAsync の戻りだけでなく、リダイレクト後に response が更新されるケースも拾う
  useEffect(() => {
    const token = response?.type === 'success' ? (response.params as Record<string, string>)?.access_token : undefined;
    if (!token) return;
    finishWithAccessToken(token).catch((e) => {
      webAlert('ログインエラー', e?.message ?? String(e));
    });
  }, [response, finishWithAccessToken]);

  const handleSignIn = useCallback(async () => {
    if (!clientId) {
      webAlert(
        'Google連携の設定が必要です',
        'プロジェクト直下の .env に EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID を設定してから再起動してください。'
      );
      return;
    }

    // expo-auth-session: request が null の間に promptAsync を呼ぶと例外になる（Webで「何も起きない」原因）
    if (!request) {
      webAlert('準備中です', '数秒待ってからもう一度「Googleでログイン」を押してください。');
      return;
    }

    try {
      const result = await promptAsync();
      if (result?.type === 'success' && result.params.access_token) {
        await finishWithAccessToken(result.params.access_token as string);
        return;
      }
      if (result?.type === 'error') {
        webAlert('ログインエラー', result.error?.message ?? 'Googleログインに失敗しました。');
      } else if (result?.type === 'cancel' || result?.type === 'dismiss') {
        // ユーザーが閉じただけ — 何もしない
      }
    } catch (e: any) {
      webAlert('Googleログイン', e?.message ?? String(e));
    }
  }, [clientId, request, promptAsync, finishWithAccessToken]);

  const handleSignOut = useCallback(async () => {
    await signOut();
  }, [signOut]);

  return { handleSignIn, handleSignOut, isSignedIn, request, redirectUri, clientId };
}
