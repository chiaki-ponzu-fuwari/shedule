import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Stamp } from '../types';
import { ALL_DEFAULT_STAMPS } from '../constants/defaultStamps';

interface StampState {
  stamps: Stamp[];
  addStamp: (stamp: Stamp) => void;
  addImageStamp: (uri: string) => Stamp;
  removeStamp: (id: string) => void;
  updateStamp: (id: string, updates: Partial<Stamp>) => void;
  toggleEnabled: (id: string) => void;
  resetToDefaults: () => void;
  getStamp: (id: string) => Stamp | undefined;
  mainStamps: () => Stamp[];
  miniStamps: () => Stamp[];
  imageStamps: () => Stamp[];
}

export const useStampStore = create<StampState>()(
  persist(
    (set, get) => ({
      stamps: ALL_DEFAULT_STAMPS,

      addStamp: (stamp) =>
        set((state) => ({ stamps: [...state.stamps, stamp] })),

      addImageStamp: (uri) => {
        const stamp: Stamp = {
          id: `img_${Date.now()}`,
          text: '',
          bgColor: '#FFFFFF',
          textColor: '#000000',
          isImageStamp: true,
          imageUri: uri,
        };
        set((state) => ({ stamps: [...state.stamps, stamp] }));
        return stamp;
      },

      removeStamp: (id) =>
        set((state) => ({
          stamps: state.stamps.filter((s) => s.id !== id),
        })),

      updateStamp: (id, updates) =>
        set((state) => ({
          stamps: state.stamps.map((s) =>
            s.id === id ? { ...s, ...updates } : s
          ),
        })),

      toggleEnabled: (id) =>
        set((state) => ({
          stamps: state.stamps.map((s) =>
            s.id === id ? { ...s, isEnabled: s.isEnabled === false ? true : false } : s
          ),
        })),

      resetToDefaults: () => set({ stamps: ALL_DEFAULT_STAMPS }),

      getStamp: (id) => get().stamps.find((s) => s.id === id),

      mainStamps: () =>
        get().stamps.filter((s) => s.isMain !== false),

      miniStamps: () =>
        get().stamps.filter((s) => (s.isMain === false || s.isMain === undefined) && !s.isImageStamp),

      imageStamps: () =>
        get().stamps.filter((s) => s.isImageStamp === true),
    }),
    {
      name: 'stamp-storage-v8',
      storage: createJSONStorage(() => AsyncStorage),
    }
  )
);
