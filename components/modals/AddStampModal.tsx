import React, { useState, useEffect } from 'react';
import {
  View, Text, Modal, TouchableOpacity, TextInput, StyleSheet,
  ScrollView,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { useStampStore } from '../../store/stampStore';
import { colors } from '../../constants/colors';
import { Stamp } from '../../types';

interface Props {
  visible: boolean;
  onClose: () => void;
  editStamp?: Stamp;   // 渡すと編集モード
}

function limitToChars(input: string, max: number) {
  return Array.from(input).slice(0, max).join('');
}

export function AddStampModal({ visible, onClose, editStamp }: Props) {
  const isEditMode = !!editStamp;

  const [text, setText] = useState('');
  const [bgColor, setBgColor] = useState('#FF6B9D');
  const [textColor, setTextColor] = useState('#FFFFFF');
  const [isMain, setIsMain] = useState(true);

  const addStamp = useStampStore((s) => s.addStamp);
  const updateStamp = useStampStore((s) => s.updateStamp);

  // 編集モード時に既存値を流し込む
  useEffect(() => {
    if (visible && editStamp) {
      setText(editStamp.text);
      setBgColor(editStamp.bgColor);
      setTextColor(editStamp.textColor);
      setIsMain(editStamp.isMain !== false);
    } else if (visible && !editStamp) {
      setText('');
      setBgColor('#FF6B9D');
      setTextColor('#FFFFFF');
      setIsMain(true);
    }
  }, [visible, editStamp]);

  const handleSave = () => {
    const normalized = limitToChars(text.trim(), 2);
    if (!normalized) return;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    if (isEditMode && editStamp) {
      updateStamp(editStamp.id, {
        text: normalized,
        bgColor,
        textColor,
        isMain: isMain ? (editStamp.isDefault ? true : undefined) : false,
      });
    } else {
      addStamp({
        id: `custom_${Date.now()}`,
        text: normalized,
        bgColor,
        textColor,
        isDefault: false,
        isMain: isMain ? undefined : false,
      });
    }
    onClose();
  };

  return (
    <Modal
      transparent
      animationType="slide"
      visible={visible}
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.overlay}>
        <View style={styles.sheet}>
          <View style={styles.handle} />

          <View style={styles.header}>
            <Text style={styles.title}>{isEditMode ? 'スタンプを編集' : 'スタンプを作る'}</Text>
            <TouchableOpacity onPress={onClose} style={styles.closeBtn}>
              <Text style={styles.closeBtnText}>✕</Text>
            </TouchableOpacity>
          </View>

          <ScrollView showsVerticalScrollIndicator={false}>
            {/* プレビュー */}
            <View style={styles.previewSection}>
              <View style={[styles.preview, { backgroundColor: bgColor }]}>
                <Text style={[styles.previewText, { color: textColor }]}>
                  {text || 'AB'}
                </Text>
              </View>
            </View>

            {/* テキスト */}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>テキスト（最大2文字）</Text>
              <TextInput
                style={styles.textInput}
                value={text}
                onChangeText={setText}
                onEndEditing={() => setText((p) => limitToChars(p.trim(), 2))}
                onSubmitEditing={() => setText((p) => limitToChars(p.trim(), 2))}
                placeholder="例: 日勤、休"
                placeholderTextColor={colors.textLight}
                returnKeyType="done"
                autoFocus
              />
              <Text style={styles.charCount}>{Array.from(text).length}/2</Text>
            </View>

            {/* 種類 */}
            <View style={styles.toggleRow}>
              <View>
                <Text style={styles.fieldLabel}>種類</Text>
                <Text style={styles.fieldSub}>{isMain ? 'メイン帯に使用' : 'ミニスタンプ専用'}</Text>
              </View>
              <View style={styles.toggleGroup}>
                <TouchableOpacity
                  style={[styles.typeBtn, isMain && styles.typeBtnActive]}
                  onPress={() => { Haptics.selectionAsync(); setIsMain(true); }}
                >
                  <Text style={[styles.typeBtnText, isMain && styles.typeBtnTextActive]}>メイン</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.typeBtn, !isMain && styles.typeBtnActiveSecondary]}
                  onPress={() => { Haptics.selectionAsync(); setIsMain(false); }}
                >
                  <Text style={[styles.typeBtnText, !isMain && styles.typeBtnTextActiveSecondary]}>ミニ専用</Text>
                </TouchableOpacity>
              </View>
            </View>

            {/* 背景色 */}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>背景色</Text>
              <View style={styles.colorGrid}>
                {colors.stampColors.map((c) => (
                  <TouchableOpacity
                    key={c}
                    style={[
                      styles.colorDot,
                      { backgroundColor: c },
                      bgColor === c && styles.colorDotSelected,
                      c === '#FFFFFF' && styles.colorDotWhite,
                    ]}
                    onPress={() => { Haptics.selectionAsync(); setBgColor(c); }}
                  />
                ))}
              </View>
            </View>

            {/* 文字色 */}
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>文字色</Text>
              <View style={styles.textColorRow}>
                {colors.stampTextColors.map((c) => (
                  <TouchableOpacity
                    key={c}
                    style={[
                      styles.textColorDot,
                      { backgroundColor: c },
                      textColor === c && styles.colorDotSelected,
                      c === '#FFFFFF' && styles.colorDotWhite,
                    ]}
                    onPress={() => { Haptics.selectionAsync(); setTextColor(c); }}
                  >
                    <Text style={{ color: c === '#FFFFFF' ? '#333' : '#FFF', fontSize: 11, fontWeight: '700' }}>A</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </View>

            {/* 保存ボタン */}
            <TouchableOpacity
              style={[styles.saveBtn, !text.trim() && styles.saveBtnDisabled]}
              onPress={handleSave}
              disabled={!text.trim()}
            >
              <Text style={styles.saveBtnText}>{isEditMode ? '変更を保存 ✓' : '保存する ✓'}</Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, backgroundColor: 'rgba(45,27,105,0.45)', justifyContent: 'flex-end' },
  sheet: { backgroundColor: '#FFFFFF', borderTopLeftRadius: 28, borderTopRightRadius: 28, paddingHorizontal: 20, paddingBottom: 40, maxHeight: '90%' },
  handle: { width: 40, height: 4, borderRadius: 2, backgroundColor: '#E0D0F0', alignSelf: 'center', marginTop: 10, marginBottom: 8 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 10 },
  title: { fontSize: 18, fontWeight: '800', color: colors.text },
  closeBtn: { width: 30, height: 30, borderRadius: 15, backgroundColor: '#F0E6F0', alignItems: 'center', justifyContent: 'center' },
  closeBtnText: { fontSize: 12, color: colors.textSecondary, fontWeight: '700' },
  previewSection: { alignItems: 'center', paddingVertical: 16 },
  preview: { width: 80, height: 80, borderRadius: 20, alignItems: 'center', justifyContent: 'center', shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 8, elevation: 5 },
  previewText: { fontSize: 28, fontWeight: '900' },
  field: { marginBottom: 16 },
  fieldLabel: { fontSize: 13, fontWeight: '700', color: colors.text, marginBottom: 8 },
  fieldSub: { fontSize: 11, color: colors.textSecondary, marginTop: 2 },
  textInput: { borderWidth: 2, borderColor: colors.border, borderRadius: 12, paddingHorizontal: 16, paddingVertical: 12, fontSize: 20, fontWeight: '800', color: colors.text, textAlign: 'center', letterSpacing: 4 },
  charCount: { fontSize: 11, color: colors.textLight, textAlign: 'right', marginTop: 4 },
  toggleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  toggleGroup: { flexDirection: 'row', gap: 8 },
  typeBtn: { paddingHorizontal: 14, paddingVertical: 8, borderRadius: 10, borderWidth: 1.5, borderColor: colors.border, backgroundColor: '#FAFAFA' },
  typeBtnActive: { borderColor: colors.primary, backgroundColor: '#FFE4F0' },
  typeBtnActiveSecondary: { borderColor: colors.secondary, backgroundColor: '#EDE9FE' },
  typeBtnText: { fontSize: 13, fontWeight: '600', color: colors.textSecondary },
  typeBtnTextActive: { color: colors.primary },
  typeBtnTextActiveSecondary: { color: colors.secondary },
  colorGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  colorDot: { width: 36, height: 36, borderRadius: 10 },
  colorDotSelected: { borderWidth: 3, borderColor: colors.text, transform: [{ scale: 1.15 }] },
  colorDotWhite: { borderWidth: 1, borderColor: colors.border },
  textColorRow: { flexDirection: 'row', gap: 10 },
  textColorDot: { width: 44, height: 44, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  saveBtn: { backgroundColor: colors.primary, borderRadius: 16, paddingVertical: 16, alignItems: 'center', marginTop: 8, marginBottom: 8, shadowColor: colors.primary, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 8, elevation: 4 },
  saveBtnDisabled: { backgroundColor: colors.textLight, shadowOpacity: 0 },
  saveBtnText: { fontSize: 16, fontWeight: '800', color: '#FFFFFF' },
});
