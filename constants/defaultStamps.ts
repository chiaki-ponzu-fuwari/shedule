import { Stamp } from '../types';

// メインスタンプ（デフォルト4種）
export const DEFAULT_MAIN_STAMPS: Stamp[] = [
  { id: 'main_day',   text: '日勤', bgColor: '#D4699A', textColor: '#FFFFFF', isDefault: true, isMain: true },
  { id: 'main_night', text: '夜勤', bgColor: '#4A8FB5', textColor: '#FFFFFF', isDefault: true, isMain: true },
  { id: 'main_work',  text: '出勤', bgColor: '#60A5FA', textColor: '#FFFFFF', isDefault: true, isMain: true },
  { id: 'main_off',   text: '休',   bgColor: '#9CA3AF', textColor: '#FFFFFF', isDefault: true, isMain: true },
  { id: 'main_juku',  text: '塾',   bgColor: '#A78BFA', textColor: '#FFFFFF', isDefault: true, isMain: true },
  { id: 'main_test',  text: 'テスト', bgColor: '#E8855A', textColor: '#FFFFFF', isDefault: true, isMain: true },
];

// ミニスタンプ（デフォルト2種）
export const DEFAULT_MINI_STAMPS: Stamp[] = [
  { id: 'mini_gym',      text: 'ジム', bgColor: '#F97316', textColor: '#FFFFFF', isDefault: true, isMain: false },
  { id: 'mini_study',    text: '勉強', bgColor: '#FBBF24', textColor: '#78350F', isDefault: true, isMain: false },
  { id: 'mini_meeting',  text: '会議', bgColor: '#6B7280', textColor: '#FFFFFF', isDefault: true, isMain: false },
  { id: 'mini_trip',     text: '出張', bgColor: '#0EA5E9', textColor: '#FFFFFF', isDefault: true, isMain: false },
];

// デフォルト画像スタンプ（アイコン型）
export const DEFAULT_IMAGE_STAMPS: Stamp[] = [
  {
    id: 'imgstamp_airplane',
    text: '',
    bgColor: '#EDE9FE',
    textColor: '#7C3AED',
    isDefault: true,
    isImageStamp: true,
    imageUri: 'icon://airplane-outline',
  },
  {
    id: 'imgstamp_car',
    text: '',
    bgColor: '#DBEAFE',
    textColor: '#1D4ED8',
    isDefault: true,
    isImageStamp: true,
    imageUri: 'icon://car-outline',
  },
  {
    id: 'imgstamp_phone',
    text: '',
    bgColor: '#D1FAE5',
    textColor: '#065F46',
    isDefault: true,
    isImageStamp: true,
    imageUri: 'icon://call-outline',
  },
  {
    id: 'imgstamp_heart',
    text: '',
    bgColor: '#FFE4F0',
    textColor: '#FF6B9D',
    isDefault: true,
    isImageStamp: true,
    imageUri: 'icon://heart',
  },
];

export const ALL_DEFAULT_STAMPS: Stamp[] = [
  ...DEFAULT_MAIN_STAMPS,
  ...DEFAULT_MINI_STAMPS,
  ...DEFAULT_IMAGE_STAMPS,
];
