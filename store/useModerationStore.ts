import { useStore } from 'zustand';
import { createSupabaseModerationApi } from '../lib/moderation/supabaseModerationApi';
import {
  createModerationStore,
  type ModerationState,
} from './moderationStore';
import { useAppSessionStore } from './appSessionStore';

const moderationStore = createModerationStore(createSupabaseModerationApi());
moderationStore.getState().setOwner(useAppSessionStore.getState().userId);
useAppSessionStore.subscribe((state, previousState) => {
  if (state.userId !== previousState.userId) {
    moderationStore.getState().setOwner(state.userId);
  }
});

export function useModerationStore<T>(selector: (state: ModerationState) => T): T {
  return useStore(moderationStore, selector);
}

export { moderationStore };
