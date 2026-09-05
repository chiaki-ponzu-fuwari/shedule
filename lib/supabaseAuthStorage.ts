export const SECURE_AUTH_CHUNK_BYTES = 1_800;

const STORAGE_VERSION = 1;
const MAX_SECURE_AUTH_CHUNKS = 128;

type Slot = 'a' | 'b';

type ActiveManifest =
  | { version: 1; active: Slot }
  | { version: 1; removed: true };

type SlotManifest = {
  version: 1;
  state: 'writing' | 'ready';
  chunks: number;
  length: number;
  checksum: string;
};

export interface SecureStringStorage {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface LegacyStringStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export type SupabaseAuthStorage = Pick<
  LegacyStringStorage,
  'getItem' | 'setItem' | 'removeItem'
>;

export function withoutOAuthProviderTokens(value: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    // PKCE verifiers and other scalar SDK values are not JSON sessions.
    return value;
  }

  let changed = false;
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key === 'provider_token' || key === 'provider_refresh_token') {
        delete record[key];
        changed = true;
      } else {
        visit(record[key]);
      }
    }
  };
  visit(decoded);
  return changed ? JSON.stringify(decoded) : value;
}

export function createProviderTokenStrippingStorage(
  storage: SupabaseAuthStorage,
): SupabaseAuthStorage {
  return {
    getItem: (key) => storage.getItem(key),
    setItem: (key, value) => storage.setItem(key, withoutOAuthProviderTokens(value)),
    removeItem: (key) => storage.removeItem(key),
  };
}

type NativeStorageOptions = {
  kind: 'native';
  secureStore: SecureStringStorage;
  legacyStorage: LegacyStringStorage;
};

type WebStorageOptions = {
  kind: 'web';
  webStorage: SupabaseAuthStorage;
};

function utf8ByteLength(symbol: string) {
  const codePoint = symbol.codePointAt(0) ?? 0;
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  if (codePoint <= 0xffff) return 3;
  return 4;
}

function splitIntoSecureChunks(value: string) {
  const chunks: string[] = [];
  let chunk = '';
  let bytes = 0;

  for (const symbol of value) {
    const symbolBytes = utf8ByteLength(symbol);
    if (chunk && bytes + symbolBytes > SECURE_AUTH_CHUNK_BYTES) {
      chunks.push(chunk);
      chunk = '';
      bytes = 0;
    }
    chunk += symbol;
    bytes += symbolBytes;
  }
  chunks.push(chunk);

  if (chunks.length > MAX_SECURE_AUTH_CHUNKS) {
    throw new Error('Secure session is too large to store safely');
  }
  return chunks;
}

function checksum(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function encodeSecureKey(key: string) {
  let encoded = '';
  for (const symbol of key) {
    if (/^[A-Za-z0-9.-]$/.test(symbol)) {
      encoded += symbol;
    } else {
      encoded += `_u${symbol.codePointAt(0)?.toString(16) ?? '0'}_`;
    }
  }
  return encoded || 'empty';
}

function storageKeys(key: string) {
  const base = `recoto.supabase.${encodeSecureKey(key)}`;
  return {
    active: `${base}.active`,
    slot: (slot: Slot) => `${base}.slot-${slot}`,
    chunk: (slot: Slot, index: number) => `${base}.slot-${slot}.chunk.${index}`,
  };
}

function parseActiveManifest(raw: string | null): ActiveManifest | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Secure session manifest verification failed');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Secure session manifest verification failed');
  }
  const record = value as Record<string, unknown>;
  if (record.version !== STORAGE_VERSION) {
    throw new Error('Secure session manifest verification failed');
  }
  if (record.removed === true) return { version: 1, removed: true };
  if (record.active === 'a' || record.active === 'b') {
    return { version: 1, active: record.active };
  }
  throw new Error('Secure session manifest verification failed');
}

function parseSlotManifest(raw: string | null): SlotManifest | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.version !== STORAGE_VERSION ||
    (record.state !== 'writing' && record.state !== 'ready') ||
    !Number.isInteger(record.chunks) ||
    (record.chunks as number) < 1 ||
    (record.chunks as number) > MAX_SECURE_AUTH_CHUNKS ||
    !Number.isInteger(record.length) ||
    (record.length as number) < 0 ||
    typeof record.checksum !== 'string'
  ) {
    return null;
  }
  return record as SlotManifest;
}

function slotManifest(value: string, chunkCount: number, state: SlotManifest['state']): SlotManifest {
  return {
    version: 1,
    state,
    chunks: chunkCount,
    length: value.length,
    checksum: checksum(value),
  };
}

function assertVerifiedValue(value: string, manifest: SlotManifest) {
  if (value.length !== manifest.length || checksum(value) !== manifest.checksum) {
    throw new Error('Secure session verification failed');
  }
}

function createNativeSupabaseAuthStorage({
  secureStore,
  legacyStorage,
}: Omit<NativeStorageOptions, 'kind'>): SupabaseAuthStorage {
  const queues = new Map<string, Promise<void>>();

  function locked<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    queues.set(key, tail);
    return result.finally(() => {
      if (queues.get(key) === tail) queues.delete(key);
    });
  }

  async function cleanupSlot(key: string, slot: Slot) {
    const keys = storageKeys(key);
    const rawManifest = await secureStore.getItemAsync(keys.slot(slot));
    const manifest = parseSlotManifest(rawManifest);
    const chunkCount = manifest?.chunks ?? (rawManifest === null ? 0 : MAX_SECURE_AUTH_CHUNKS);
    let firstError: unknown = null;

    for (let index = 0; index < chunkCount; index += 1) {
      try {
        await secureStore.deleteItemAsync(keys.chunk(slot, index));
      } catch (error) {
        firstError ??= error;
      }
    }
    if (!firstError) {
      try {
        await secureStore.deleteItemAsync(keys.slot(slot));
      } catch (error) {
        firstError = error;
      }
    }
    if (firstError) throw firstError;
  }

  async function readSlot(key: string, slot: Slot) {
    const keys = storageKeys(key);
    const manifest = parseSlotManifest(await secureStore.getItemAsync(keys.slot(slot)));
    if (!manifest || manifest.state !== 'ready') {
      throw new Error('Secure session verification failed');
    }

    const chunks: string[] = [];
    for (let index = 0; index < manifest.chunks; index += 1) {
      const chunk = await secureStore.getItemAsync(keys.chunk(slot, index));
      if (chunk === null) throw new Error('Secure session verification failed');
      chunks.push(chunk);
    }
    const value = chunks.join('');
    assertVerifiedValue(value, manifest);
    return value;
  }

  async function readSecure(key: string): Promise<
    | { status: 'missing' | 'removed' }
    | { status: 'value'; value: string }
  > {
    const keys = storageKeys(key);
    const manifest = parseActiveManifest(await secureStore.getItemAsync(keys.active));
    if (!manifest) return { status: 'missing' };
    if ('removed' in manifest) return { status: 'removed' };
    return { status: 'value', value: await readSlot(key, manifest.active) };
  }

  async function writeSecure(key: string, value: string) {
    const keys = storageKeys(key);
    const current = parseActiveManifest(await secureStore.getItemAsync(keys.active));
    const currentSlot = current && 'active' in current ? current.active : null;
    const targetSlot: Slot = currentSlot === 'a' ? 'b' : 'a';
    const chunks = splitIntoSecureChunks(value);
    const writingManifest = slotManifest(value, chunks.length, 'writing');
    const readyManifest = { ...writingManifest, state: 'ready' as const };

    await cleanupSlot(key, targetSlot);
    await secureStore.setItemAsync(keys.slot(targetSlot), JSON.stringify(writingManifest));

    let switchAttempted = false;
    try {
      for (let index = 0; index < chunks.length; index += 1) {
        await secureStore.setItemAsync(keys.chunk(targetSlot, index), chunks[index]);
      }

      const writtenChunks: string[] = [];
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = await secureStore.getItemAsync(keys.chunk(targetSlot, index));
        if (chunk === null) throw new Error('Secure session verification failed');
        writtenChunks.push(chunk);
      }
      if (writtenChunks.join('') !== value) {
        throw new Error('Secure session verification failed');
      }

      await secureStore.setItemAsync(keys.slot(targetSlot), JSON.stringify(readyManifest));
      const verified = await readSlot(key, targetSlot);
      if (verified !== value) throw new Error('Secure session verification failed');

      switchAttempted = true;
      await secureStore.setItemAsync(
        keys.active,
        JSON.stringify({ version: STORAGE_VERSION, active: targetSlot }),
      );
    } catch (error) {
      // Until the active manifest is switched, the previous generation remains
      // authoritative. A failed manifest write may still be ambiguous at the
      // platform boundary, so leave the ready target for the next cleanup.
      if (!switchAttempted) await cleanupSlot(key, targetSlot).catch(() => undefined);
      throw error;
    }

    if (currentSlot && currentSlot !== targetSlot) {
      await cleanupSlot(key, currentSlot).catch(() => undefined);
    }
  }

  async function removeSecure(key: string) {
    const keys = storageKeys(key);
    // A durable tombstone is authoritative before cleanup, preventing a stale
    // AsyncStorage value from being migrated if deletion is interrupted.
    await secureStore.setItemAsync(
      keys.active,
      JSON.stringify({ version: STORAGE_VERSION, removed: true }),
    );

    let firstError: unknown = null;
    for (const slot of ['a', 'b'] as const) {
      try {
        await cleanupSlot(key, slot);
      } catch (error) {
        firstError ??= error;
      }
    }
    try {
      await legacyStorage.removeItem(key);
    } catch (error) {
      firstError ??= error;
    }
    if (firstError) throw firstError;
  }

  return {
    getItem: (key) =>
      locked(key, async () => {
        const secure = await readSecure(key);
        if (secure.status === 'value') {
          await legacyStorage.removeItem(key).catch(() => undefined);
          return secure.value;
        }
        if (secure.status === 'removed') {
          await legacyStorage.removeItem(key).catch(() => undefined);
          return null;
        }

        const legacy = await legacyStorage.getItem(key);
        if (legacy === null) return null;
        await writeSecure(key, legacy);
        const verified = await readSecure(key);
        if (verified.status !== 'value' || verified.value !== legacy) {
          throw new Error('Secure session migration verification failed');
        }
        await legacyStorage.removeItem(key);
        return verified.value;
      }),

    setItem: (key, value) =>
      locked(key, async () => {
        await writeSecure(key, value);
        const verified = await readSecure(key);
        if (verified.status !== 'value' || verified.value !== value) {
          throw new Error('Secure session verification failed');
        }
        await legacyStorage.removeItem(key).catch(() => undefined);
      }),

    removeItem: (key) => locked(key, () => removeSecure(key)),
  };
}

export function createSupabaseAuthStorage(
  options: NativeStorageOptions | WebStorageOptions,
): SupabaseAuthStorage {
  if (options.kind === 'web') return options.webStorage;
  return createNativeSupabaseAuthStorage(options);
}
