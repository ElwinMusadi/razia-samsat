import { AppError } from '../../shared/errors';
import type { Fetcher } from './contracts';

export type UpstreamLimits = { timeoutMs: number; maxBytes: number };
export type UpstreamBody = {
  /** Reads and parses the bounded JSON body. Oversize/invalid UTF-8/invalid JSON is UPSTREAM_MALFORMED. */
  json(): Promise<unknown>;
  /** Cancels the body without awaiting the untrusted stream. */
  discard(): void;
};

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (body) void body.cancel().catch(() => undefined);
}

async function readBoundedJson(response: Response, maxBytes: number, registerCancellation: (cancel: () => void) => void): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    cancelBody(response.body);
    throw new AppError('UPSTREAM_MALFORMED');
  }
  if (!response.body) throw new AppError('UPSTREAM_MALFORMED');
  const reader = response.body.getReader();
  registerCancellation(() => { void reader.cancel().catch(() => undefined); });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new AppError('UPSTREAM_MALFORMED');
      chunks.push(value);
    }
  } catch (error) {
    // Never await cancellation: an untrusted stream may never settle cancel().
    void reader.cancel().catch(() => undefined);
    throw error instanceof AppError ? error : new AppError('UPSTREAM_NETWORK');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)); }
  catch { throw new AppError('UPSTREAM_MALFORMED'); }
}

/** Sanitizes Retry-After to whole seconds in 0..3600; anything else is dropped. */
export function retryAfterSeconds(response: Response): string | undefined {
  const retry = response.headers.get('retry-after');
  return retry !== null && /^\d{1,4}$/.test(retry) && Number(retry) <= 3600 ? String(Number(retry)) : undefined;
}

/**
 * One total deadline covers connection, headers and the streamed body, even when the injected
 * fetcher ignores abort. Redirects are never followed (`redirect: 'manual'`), so credentials and
 * plates cannot travel to another host. No retry on any path.
 */
export async function upstreamRequest<T>(fetcher: Fetcher, url: string, init: Omit<RequestInit, 'signal' | 'redirect'>, limits: UpstreamLimits, handle: (response: Response, body: UpstreamBody) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let activeReaderCancel: (() => void) | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      reject(new AppError('TIMEOUT'));
      controller.abort();
      activeReaderCancel?.();
    }, limits.timeoutMs);
  });
  const operation = async (): Promise<T> => {
    let response: Response;
    try { response = await fetcher(url, { ...init, redirect: 'manual', signal: controller.signal }); }
    catch { throw new AppError(controller.signal.aborted ? 'TIMEOUT' : 'UPSTREAM_NETWORK'); }
    if (controller.signal.aborted) { cancelBody(response.body); throw new AppError('TIMEOUT'); }
    const body: UpstreamBody = {
      json: () => readBoundedJson(response, limits.maxBytes, cancel => { activeReaderCancel = cancel; }),
      discard: () => cancelBody(response.body),
    };
    const result = await handle(response, body);
    if (controller.signal.aborted) throw new AppError('TIMEOUT');
    return result;
  };
  try { return await Promise.race([operation(), deadline]); }
  finally { if (timeout !== undefined) clearTimeout(timeout); }
}
