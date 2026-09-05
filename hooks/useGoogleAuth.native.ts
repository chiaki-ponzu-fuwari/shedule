import { useCallback } from 'react';
import { Alert } from 'react-native';

/**
 * Expo Go では expo-auth-session が内部で ExpoCrypto を要求する環境があり、
 * 画面を開いただけでクラッシュすることがあるため、ネイティブ側は無効化する。
 * Google連携は「開発ビルド（dev client）」で有効化する想定。
 */
export function useGoogleAuth() {
  const handleSignIn = useCallback(async () => {
    Alert.alert(
      'Googleログイン（iOS/Android）',
      '現在は Expo Go だとGoogleログインがクラッシュするため無効化しています。\n\nGoogle連携を使う場合は開発ビルド（Dev Client）を作成してから有効化します。'
    );
  }, []);

  const handleSignOut = useCallback(async () => {}, []);

  return {
    handleSignIn,
    handleSignOut,
    isSignedIn: false,
    request: null as any,
    redirectUri: '',
    clientId: '',
  };
}
