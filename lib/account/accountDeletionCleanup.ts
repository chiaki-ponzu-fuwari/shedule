const ACCOUNT_GLOBAL_STORAGE_KEYS = new Set([
  'recoto:account-bootstrap-binding:v1',
  'group-storage-v2',
  'google-auth-storage',
  'google-sync-settings',
]);

export function accountDeletionNeedsNativeNotificationCleanup(platform: string): boolean {
  return platform === 'ios' || platform === 'android';
}

export interface AccountDeletionCleanupDependencies {
  readInstallationId(): Promise<string>;
  listStorageKeys(): Promise<readonly string[]>;
  removeStorageKeys(keys: string[]): Promise<void>;
  cancelNotifications(): Promise<void>;
  disconnectGoogleCalendar(): Promise<void>;
  clearAuthSession(): Promise<void>;
  clearAuthOperations(): Promise<void>;
  /** Removes app-owned staged media before its durable retry pointers. */
  clearPersonalMedia(ownerId: string): Promise<void>;
  /** Hides deleted-user group data synchronously before persistent cache removal. */
  resetGroupState(): void;
  selectEmptyGuest(): Promise<void>;
  resetAccountState(): void;
}

function storageSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes(':')) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

export function selectDeletedAccountStorageKeys({
  ownerId: ownerIdInput,
  installationId: installationIdInput,
  keys,
}: {
  ownerId: string;
  installationId: string;
  keys: readonly string[];
}): string[] {
  const ownerId = storageSegment(ownerIdInput, 'Deleted account owner');
  const installationId = storageSegment(installationIdInput, 'Installation owner');
  const userPrefix = `recoto:user:${ownerId}:`;
  const guestPrefix = `recoto:guest:${installationId}:`;
  return keys.filter((key) =>
    key.startsWith(userPrefix)
    || key.startsWith(guestPrefix)
    || ACCOUNT_GLOBAL_STORAGE_KEYS.has(key));
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : String(error);
}

export async function clearDeletedAccountLocally(
  dependencies: AccountDeletionCleanupDependencies,
  ownerIdInput: string,
): Promise<{ complete: boolean; errors: string[] }> {
  const ownerId = storageSegment(ownerIdInput, 'Deleted account owner');
  const errors: string[] = [];

  const run = async (label: string, operation: () => Promise<void>) => {
    try {
      await operation();
      return true;
    } catch (error) {
      errors.push(`${label}: ${errorMessage(error)}`);
      return false;
    }
  };

  await run('notifications', dependencies.cancelNotifications);
  await run('google-calendar', dependencies.disconnectGoogleCalendar);
  await run('auth-session', dependencies.clearAuthSession);
  await run('auth-operations', dependencies.clearAuthOperations);
  const personalMediaCleared = await run(
    'personal-media',
    () => dependencies.clearPersonalMedia(ownerId),
  );
  try {
    dependencies.resetGroupState();
  } catch (error) {
    errors.push(`group-state: ${errorMessage(error)}`);
  }
  if (personalMediaCleared) await run('personal-storage', async () => {
    const installationId = await dependencies.readInstallationId();
    const selected = selectDeletedAccountStorageKeys({
      ownerId,
      installationId,
      keys: await dependencies.listStorageKeys(),
    });
    if (selected.length > 0) await dependencies.removeStorageKeys(selected);

    const remaining = selectDeletedAccountStorageKeys({
      ownerId,
      installationId,
      keys: await dependencies.listStorageKeys(),
    });
    if (remaining.length > 0) {
      throw new Error('deleted account data is still present');
    }
  });
  await run('guest-cache', dependencies.selectEmptyGuest);
  try {
    dependencies.resetAccountState();
  } catch (error) {
    errors.push(`account-state: ${errorMessage(error)}`);
  }

  return { complete: errors.length === 0, errors };
}
