import type { AccountBootstrapGate } from './accountBootstrap';

const DEFAULT_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;

export function createAccountBootstrapRetryScheduler({
  canRetry,
  retry,
  delaysMs = DEFAULT_DELAYS_MS,
}: {
  canRetry(ownerId: string): boolean;
  retry(): void;
  delaysMs?: readonly number[];
}) {
  if (delaysMs.length === 0 || delaysMs.some((delay) => !Number.isFinite(delay) || delay < 0)) {
    throw new Error('At least one safe retry delay is required');
  }

  let active = true;
  let attempt = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clear = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  return {
    update(gate: AccountBootstrapGate) {
      clear();
      if (gate.status === 'ready') {
        attempt = 0;
        return;
      }
      if (!active || gate.status !== 'safe-failure' || !canRetry(gate.ownerId)) return;

      const ownerId = gate.ownerId;
      const delay = delaysMs[Math.min(attempt, delaysMs.length - 1)];
      attempt += 1;
      timer = setTimeout(() => {
        timer = null;
        if (active && canRetry(ownerId)) retry();
      }, delay);
    },

    stop() {
      if (!active) return;
      active = false;
      clear();
    },
  };
}
