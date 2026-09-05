import { Platform } from 'react-native';
import * as ImageManipulator from 'expo-image-manipulator';

const MAX_EDGE = 1600;
const JPEG_QUALITY = 0.82;

/** ライブラリで選んだ画像を端末内でリサイズ・圧縮（保存・転送サイズ削減） */
export async function compressPickedImageUri(uri: string): Promise<string> {
  if (Platform.OS === 'web') {
    return uri;
  }
  try {
    const result = await ImageManipulator.manipulateAsync(
      uri,
      [{ resize: { width: MAX_EDGE } }],
      { compress: JPEG_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
    );
    return result.uri;
  } catch {
    return uri;
  }
}
