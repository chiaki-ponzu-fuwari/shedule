import { EdgeRequestError } from './requestSecurity.ts';

type BodyRequest = {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
};

export async function readBoundedRequestBody(
  request: BodyRequest,
  maximumBytes = 8_192,
): Promise<string> {
  const contentLengthHeader = request.headers.get('Content-Length');
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new EdgeRequestError(400, 'invalid_content_length', 'Content-Length is invalid');
    }
    if (contentLength > maximumBytes) {
      throw new EdgeRequestError(413, 'body_too_large', 'Request body is too large');
    }
  }
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      byteLength += next.value.byteLength;
      if (byteLength > maximumBytes) {
        await reader.cancel('body limit exceeded').catch(() => undefined);
        throw new EdgeRequestError(413, 'body_too_large', 'Request body is too large');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new EdgeRequestError(400, 'invalid_encoding', 'Request body must be UTF-8');
  }
}
