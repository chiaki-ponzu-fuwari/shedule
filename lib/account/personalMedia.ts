import type { SupabaseClient } from '@supabase/supabase-js';
import * as Crypto from 'expo-crypto';
import * as FileSystem from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { Platform } from 'react-native';

export const MAX_PERSONAL_MEDIA_BYTES = 5 * 1024 * 1024;
export const SIGNED_MEDIA_TTL_SECONDS = 10 * 60;

export type PersonalMediaDomain = 'calendar' | 'diary' | 'stamp' | 'trip';

export interface ProcessedJpeg {
  bytes: ArrayBuffer;
  mimeType: 'image/jpeg';
}

export interface PersonalImageProcessor {
  reencodeAsJpeg(sourceUri: string): Promise<ProcessedJpeg>;
}

export interface DurableMediaStaging {
  write(id: string, bytes: ArrayBuffer): Promise<string>;
  read(stagedUri: string): Promise<ArrayBuffer>;
  remove(stagedUri: string): Promise<void>;
}

export interface BrowserMediaDatabase {
  put(id: string, bytes: ArrayBuffer): Promise<void>;
  get(id: string): Promise<ArrayBuffer | null>;
  remove(id: string): Promise<void>;
}

export interface PersonalMediaStorage {
  uploadIfAbsent(
    objectKey: string,
    bytes: ArrayBuffer,
    mimeType: 'image/jpeg',
  ): Promise<'uploaded' | 'already-exists'>;
  createSignedUrl(objectKey: string, expiresInSeconds: number): Promise<string>;
  remove(objectKeys: string[]): Promise<void>;
}

export interface MediaCleanupQueue {
  enqueue(objectKey: string): Promise<void>;
  complete(objectKey: string): Promise<void>;
  /** The worker must wait until `afterMutationId` is absent from the media outbox. */
  enqueueStagedFile(stagedUri: string, afterMutationId: string): Promise<void>;
  completeStagedFile(stagedUri: string): Promise<void>;
}

export interface PendingMediaUpload {
  mutationId: string;
  ownerId: string;
  domain: PersonalMediaDomain;
  objectKey: string;
  stagedUri: string;
  attempts: number;
}

interface PrepareInput {
  ownerId: string;
  domain: PersonalMediaDomain;
  sourceUri: string;
  persistPending(mutation: PendingMediaUpload): Promise<void>;
}

interface ReplaceInput {
  mutation: PendingMediaUpload;
  previousObjectKey?: string;
  /** Must be idempotent because a process interruption can replay this call. */
  persistObjectKey(objectKey: string): Promise<void>;
  discardPending(mutationId: string): Promise<void>;
}

export interface PersonalMediaService {
  prepare(input: PrepareInput): Promise<PendingMediaUpload>;
  uploadPending(mutation: PendingMediaUpload): Promise<{ objectKey: string }>;
  replace(input: ReplaceInput): Promise<{ objectKey: string; cleanupPending?: boolean }>;
  createSignedReadUrl(
    ownerId: string,
    domain: PersonalMediaDomain,
    objectKey: string,
  ): Promise<string>;
  scheduleCleanup(
    ownerId: string,
    domain: PersonalMediaDomain,
    objectKey: string,
  ): Promise<void>;
}

const MEDIA_DOMAINS: readonly PersonalMediaDomain[] = ['calendar', 'diary', 'stamp', 'trip'];
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_OWNER_PATTERN = /^[A-Za-z0-9_-]+$/;

function assertOwner(ownerId: string) {
  if (!SAFE_OWNER_PATTERN.test(ownerId)) throw new Error('Invalid personal media owner');
}

function assertDomain(domain: PersonalMediaDomain) {
  if (!MEDIA_DOMAINS.includes(domain)) throw new Error('Invalid personal media domain');
}

function assertUuid(value: string) {
  if (!UUID_PATTERN.test(value)) throw new Error('Personal media identifier must be a UUID');
}

function assertObjectKey(
  ownerId: string,
  expectedDomain: PersonalMediaDomain,
  objectKey: string,
) {
  assertOwner(ownerId);
  assertDomain(expectedDomain);
  const parts = objectKey.split('/');
  if (parts[0] !== ownerId) {
    throw new Error('Personal media object key belongs to another owner');
  }
  if (parts[1] !== expectedDomain) {
    throw new Error('Personal media object key belongs to another domain');
  }
  const fileId = parts.length === 3 && parts[2].endsWith('.jpg')
    ? parts[2].slice(0, -4)
    : '';
  if (parts.length !== 3 || !UUID_PATTERN.test(fileId)) {
    throw new Error('Invalid personal media object key');
  }
}

function assertProcessedJpeg(processed: ProcessedJpeg) {
  if (processed.mimeType !== 'image/jpeg') {
    throw new Error('Personal media must be re-encoded as JPEG before upload');
  }
  if (
    processed.bytes.byteLength <= 0 ||
    processed.bytes.byteLength > MAX_PERSONAL_MEDIA_BYTES
  ) {
    throw new Error('Personal media must be 5 MB or smaller after processing');
  }
}

function assertPendingMutation(mutation: PendingMediaUpload) {
  assertUuid(mutation.mutationId);
  assertObjectKey(mutation.ownerId, mutation.domain, mutation.objectKey);
  if (
    !mutation.stagedUri.startsWith('file://') &&
    !mutation.stagedUri.startsWith('recoto-idb://')
  ) {
    throw new Error('Personal media retry source is not in durable local storage');
  }
  if (!Number.isSafeInteger(mutation.attempts) || mutation.attempts < 0) {
    throw new Error('Invalid personal media retry count');
  }
}

export function createPersonalMediaService(dependencies: {
  processor: PersonalImageProcessor;
  staging: DurableMediaStaging;
  storage: PersonalMediaStorage;
  cleanupQueue: MediaCleanupQueue;
  uuid?: () => string;
}): PersonalMediaService {
  const {
    processor,
    staging,
    storage,
    cleanupQueue,
    uuid = () => Crypto.randomUUID(),
  } = dependencies;

  const finishStagedFile = async (
    mutation: PendingMediaUpload,
    discardPending: (mutationId: string) => Promise<void>,
  ) => {
    // The durable job is dependency-gated by mutationId, so it cannot remove
    // the retry source until the outbox transition below has completed.
    await cleanupQueue.enqueueStagedFile(mutation.stagedUri, mutation.mutationId);
    await discardPending(mutation.mutationId);
    try {
      await staging.remove(mutation.stagedUri);
      await cleanupQueue.completeStagedFile(mutation.stagedUri);
      return false;
    } catch {
      return true;
    }
  };

  return {
    async prepare({ ownerId, domain, sourceUri, persistPending }) {
      assertOwner(ownerId);
      assertDomain(domain);
      if (!sourceUri.trim()) throw new Error('A source image is required');

      const mutationId = uuid();
      assertUuid(mutationId);
      const processed = await processor.reencodeAsJpeg(sourceUri);
      assertProcessedJpeg(processed);
      const stagedUri = await staging.write(mutationId, processed.bytes);
      const mutation: PendingMediaUpload = {
        mutationId,
        ownerId,
        domain,
        objectKey: `${ownerId}/${domain}/${mutationId}.jpg`,
        stagedUri,
        attempts: 0,
      };
      assertPendingMutation(mutation);
      try {
        await persistPending(mutation);
      } catch (error) {
        // Persistence can commit and still reject (for example, if the response
        // is lost). Never delete the only retry source here. The cleanup worker
        // removes it only after confirming mutationId is absent from the outbox.
        await cleanupQueue.enqueueStagedFile(stagedUri, mutationId);
        throw error;
      }
      return mutation;
    },

    async uploadPending(mutation) {
      assertPendingMutation(mutation);
      const bytes = await staging.read(mutation.stagedUri);
      assertProcessedJpeg({ bytes, mimeType: 'image/jpeg' });
      await storage.uploadIfAbsent(mutation.objectKey, bytes, 'image/jpeg');
      return { objectKey: mutation.objectKey };
    },

    async replace({ mutation, previousObjectKey, persistObjectKey, discardPending }) {
      assertPendingMutation(mutation);
      if (previousObjectKey) {
        assertObjectKey(mutation.ownerId, mutation.domain, previousObjectKey);
      }

      const uploaded = await this.uploadPending(mutation);
      try {
        await persistObjectKey(uploaded.objectKey);
      } catch (error) {
        // The durable cleanup record is created before the local outbox/staging
        // reference is removed, so an uploaded-but-unreferenced object is recoverable.
        await cleanupQueue.enqueue(uploaded.objectKey);
        await finishStagedFile(mutation, discardPending);
        throw error;
      }

      const shouldRemovePrevious =
        previousObjectKey !== undefined && previousObjectKey !== uploaded.objectKey;
      if (shouldRemovePrevious) {
        // Persist this cleanup job before dropping the upload outbox. If the
        // cleanup queue itself is unavailable, replaying the fixed mutation is safe.
        await cleanupQueue.enqueue(previousObjectKey);
      }

      const stagedCleanupPending = await finishStagedFile(mutation, discardPending);

      if (shouldRemovePrevious) {
        try {
          await storage.remove([previousObjectKey]);
          await cleanupQueue.complete(previousObjectKey);
        } catch {
          return { ...uploaded, cleanupPending: true };
        }
      }
      return stagedCleanupPending ? { ...uploaded, cleanupPending: true } : uploaded;
    },

    async createSignedReadUrl(ownerId, domain, objectKey) {
      assertObjectKey(ownerId, domain, objectKey);
      return storage.createSignedUrl(objectKey, SIGNED_MEDIA_TTL_SECONDS);
    },

    async scheduleCleanup(ownerId, domain, objectKey) {
      assertObjectKey(ownerId, domain, objectKey);
      await cleanupQueue.enqueue(objectKey);
    },
  };
}

export async function processPendingMediaUpload(
  mutation: PendingMediaUpload,
  service: PersonalMediaService,
  persistPending: (mutation: PendingMediaUpload) => Promise<void>,
): Promise<
  | { status: 'uploaded'; objectKey: string; mutationId: string }
  | { status: 'pending'; mutation: PendingMediaUpload; error: string }
> {
  try {
    const { objectKey } = await service.uploadPending(mutation);
    return { status: 'uploaded', objectKey, mutationId: mutation.mutationId };
  } catch (error) {
    const pending = { ...mutation, attempts: mutation.attempts + 1 };
    await persistPending(pending);
    return {
      status: 'pending',
      mutation: pending,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function bytesToBase64(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const chunk = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += alphabet[(chunk >> 18) & 63];
    encoded += alphabet[(chunk >> 12) & 63];
    encoded += second === undefined ? '=' : alphabet[(chunk >> 6) & 63];
    encoded += third === undefined ? '=' : alphabet[chunk & 63];
  }
  return encoded;
}

function base64ToArrayBuffer(encoded: string): ArrayBuffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const normalized = encoded.replace(/\s/g, '');
  if (normalized.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(normalized)) {
    throw new Error('Staged personal media is not valid base64');
  }
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array((normalized.length / 4) * 3 - padding);
  let offset = 0;
  for (let index = 0; index < normalized.length; index += 4) {
    const a = alphabet.indexOf(normalized[index]);
    const b = alphabet.indexOf(normalized[index + 1]);
    const c = normalized[index + 2] === '=' ? 0 : alphabet.indexOf(normalized[index + 2]);
    const d = normalized[index + 3] === '=' ? 0 : alphabet.indexOf(normalized[index + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) {
      throw new Error('Staged personal media is not valid base64');
    }
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    if (offset < bytes.length) bytes[offset++] = (chunk >> 16) & 255;
    if (offset < bytes.length) bytes[offset++] = (chunk >> 8) & 255;
    if (offset < bytes.length) bytes[offset++] = chunk & 255;
  }
  return bytes.buffer;
}

interface JpegProcessorOptions {
  platform?: string;
  reencode?: (sourceUri: string) => Promise<{ uri: string }>;
  fetcher?: (uri: string) => Promise<{
    ok: boolean;
    status: number;
    headers: { get(name: string): string | null };
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
  readNative?: (uri: string) => Promise<ArrayBuffer>;
}

export function createPlatformJpegProcessor(
  options: JpegProcessorOptions = {},
): PersonalImageProcessor {
  const reencode = options.reencode ?? (async (sourceUri: string) =>
    ImageManipulator.manipulateAsync(
      sourceUri,
      [],
      { compress: 0.82, format: ImageManipulator.SaveFormat.JPEG },
    ));
  return {
    async reencodeAsJpeg(sourceUri) {
      const reencoded = await reencode(sourceUri);
      let bytes: ArrayBuffer;
      if ((options.platform ?? Platform.OS) === 'web') {
        const fetcher = options.fetcher ?? ((uri: string) => fetch(uri));
        const response = await fetcher(reencoded.uri);
        if (!response.ok) {
          throw new Error(`Unable to read the processed web image (${response.status})`);
        }
        const contentType = response.headers.get('content-type')?.split(';')[0].trim();
        if (contentType && contentType !== 'image/jpeg') {
          throw new Error('Processed web media is not JPEG');
        }
        bytes = await response.arrayBuffer();
      } else if (options.readNative) {
        bytes = await options.readNative(reencoded.uri);
      } else {
        const encoded = await FileSystem.readAsStringAsync(reencoded.uri, {
          encoding: FileSystem.EncodingType.Base64,
        });
        bytes = base64ToArrayBuffer(encoded);
      }
      const processed = {
        bytes,
        mimeType: 'image/jpeg' as const,
      };
      assertProcessedJpeg(processed);
      return {
        ...processed,
      };
    },
  };
}

export function createExpoJpegProcessor(): PersonalImageProcessor {
  return createPlatformJpegProcessor();
}

export function createExpoMediaStaging(): DurableMediaStaging {
  const root = FileSystem.documentDirectory;
  if (!root) throw new Error('Durable document storage is unavailable');
  const directoryUri = `${root}recoto-media-outbox/`;
  const ensureDirectory = async () => {
    await FileSystem.makeDirectoryAsync(directoryUri, { intermediates: true });
  };
  return {
    async write(id, bytes) {
      assertUuid(id);
      await ensureDirectory();
      const fileUri = `${directoryUri}${id}.jpg`;
      await FileSystem.writeAsStringAsync(fileUri, bytesToBase64(new Uint8Array(bytes)), {
        encoding: FileSystem.EncodingType.Base64,
      });
      return fileUri;
    },
    async read(stagedUri) {
      const info = await FileSystem.getInfoAsync(stagedUri);
      if (!info.exists) throw new Error('Staged personal media is no longer available');
      const encoded = await FileSystem.readAsStringAsync(stagedUri, {
        encoding: FileSystem.EncodingType.Base64,
      });
      return base64ToArrayBuffer(encoded);
    },
    async remove(stagedUri) {
      await FileSystem.deleteAsync(stagedUri, { idempotent: true });
    },
  };
}

const BROWSER_STAGE_URI_PATTERN =
  /^recoto-idb:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.jpg$/i;

function browserStageId(uri: string) {
  const id = BROWSER_STAGE_URI_PATTERN.exec(uri)?.[1];
  if (!id) throw new Error('Invalid browser personal media staging URI');
  return id;
}

export function createBrowserMediaStaging(
  database: BrowserMediaDatabase,
): DurableMediaStaging {
  return {
    async write(id, bytes) {
      assertUuid(id);
      await database.put(id, bytes.slice(0));
      return `recoto-idb://${id}.jpg`;
    },
    async read(stagedUri) {
      const stored = await database.get(browserStageId(stagedUri));
      if (!stored) throw new Error('Staged personal media is no longer available');
      return stored.slice(0);
    },
    async remove(stagedUri) {
      await database.remove(browserStageId(stagedUri));
    },
  };
}

const BROWSER_MEDIA_DATABASE = 'recoto-personal-media';
const BROWSER_MEDIA_STORE = 'staged-files';

function openBrowserMediaDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(BROWSER_MEDIA_DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(BROWSER_MEDIA_STORE)) {
        request.result.createObjectStore(BROWSER_MEDIA_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Browser media database failed'));
    request.onblocked = () => reject(new Error('Browser media database upgrade is blocked'));
  });
}

async function runBrowserMediaTransaction<T>(
  factory: IDBFactory,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const database = await openBrowserMediaDatabase(factory);
  return new Promise((resolve, reject) => {
    let value: T;
    let requestSucceeded = false;
    let settled = false;
    const finishError = (error: unknown) => {
      if (settled) return;
      settled = true;
      database.close();
      reject(error instanceof Error ? error : new Error(String(error)));
    };

    let transaction: IDBTransaction;
    try {
      transaction = database.transaction(BROWSER_MEDIA_STORE, mode);
      const request = operation(transaction.objectStore(BROWSER_MEDIA_STORE));
      request.onsuccess = () => {
        value = request.result;
        requestSucceeded = true;
      };
      request.onerror = () => finishError(request.error ?? new Error('Browser media request failed'));
    } catch (error) {
      finishError(error);
      return;
    }

    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      database.close();
      if (!requestSucceeded) {
        reject(new Error('Browser media transaction completed without a result'));
        return;
      }
      resolve(value);
    };
    transaction.onerror = () => finishError(
      transaction.error ?? new Error('Browser media transaction failed'),
    );
    transaction.onabort = () => finishError(
      transaction.error ?? new Error('Browser media transaction was aborted'),
    );
  });
}

export function createIndexedDbMediaDatabase(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): BrowserMediaDatabase {
  if (!factory) throw new Error('Durable browser storage is unavailable');
  return {
    async put(id, bytes) {
      await runBrowserMediaTransaction(factory, 'readwrite', (store) =>
        store.put(bytes.slice(0), id));
    },
    async get(id) {
      const stored = await runBrowserMediaTransaction<unknown>(factory, 'readonly', (store) =>
        store.get(id));
      if (stored === undefined) return null;
      if (!(stored instanceof ArrayBuffer)) {
        throw new Error('Browser media database returned invalid data');
      }
      return stored.slice(0);
    },
    async remove(id) {
      await runBrowserMediaTransaction(factory, 'readwrite', (store) => store.delete(id));
    },
  };
}

export function createPlatformMediaStaging(): DurableMediaStaging {
  return Platform.OS === 'web'
    ? createBrowserMediaStaging(createIndexedDbMediaDatabase())
    : createExpoMediaStaging();
}

function isAlreadyStored(error: unknown) {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as {
    status?: string | number;
    statusCode?: string | number;
    code?: string;
    error?: string;
    message?: string;
  };
  const statusIsConflict =
    String(candidate.status ?? '') === '409' || String(candidate.statusCode ?? '') === '409';
  const duplicateCode = [candidate.statusCode, candidate.code, candidate.error]
    .some((value) => /^(KeyAlreadyExists|ResourceAlreadyExists|Duplicate)$/i.test(String(value ?? '')));
  const duplicateMessage = /already exists|resource exists|duplicate/i.test(candidate.message ?? '');
  return statusIsConflict && (duplicateCode || duplicateMessage);
}

export function createSupabasePersonalMediaStorage(
  client: SupabaseClient,
): PersonalMediaStorage {
  const bucket = client.storage.from('personal-media');
  return {
    async uploadIfAbsent(objectKey, bytes, mimeType) {
      const { error } = await bucket.upload(objectKey, bytes, {
        contentType: mimeType,
        upsert: false,
      });
      if (error && !isAlreadyStored(error)) throw error;
      return error ? 'already-exists' : 'uploaded';
    },
    async createSignedUrl(objectKey, expiresInSeconds) {
      const { data, error } = await bucket.createSignedUrl(objectKey, expiresInSeconds);
      if (error) throw error;
      if (!data?.signedUrl) throw new Error('Storage did not return a signed URL');
      return data.signedUrl;
    },
    async remove(objectKeys) {
      const { error } = await bucket.remove(objectKeys);
      if (error) throw error;
    },
  };
}
