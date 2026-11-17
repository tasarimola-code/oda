import type { IpcResult, OdaApi } from '../../shared/ipc';
import type { RpcMethod, RpcParams, RpcResult } from '../../shared/protocol';

declare global {
  interface Window {
    oda: OdaApi;
  }
}

export class OdaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function unwrap<T>(p: Promise<IpcResult<T>>): Promise<T> {
  const r = await p;
  if (r.ok) return r.data;
  throw new OdaError(r.error.code, r.error.message);
}

export const oda = (): OdaApi => window.oda;

export function rpc<M extends RpcMethod>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
  return unwrap(window.oda.client.request(method, params));
}

export function errorText(e: unknown): string {
  if (e instanceof OdaError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function randomId(len = 16): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'[b & 63]).join('');
}
