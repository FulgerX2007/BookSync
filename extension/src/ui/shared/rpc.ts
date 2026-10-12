// Typed calls from extension pages to the background.
import { ext } from '../../platform/ext';
import type { MessageType, Protocol, Response, StatusView } from '../../background/messages';

export class RpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export async function send<K extends MessageType>(type: K, payload: Protocol[K]['req'] = {} as Protocol[K]['req']): Promise<Protocol[K]['res']> {
  const res = (await ext().runtime.sendMessage({ type, ...payload })) as Response<Protocol[K]['res']> | undefined;
  if (!res) throw new RpcError('internal', 'the background did not answer');
  if (!res.ok) throw new RpcError(res.error.code, res.error.message);
  return res.data;
}

/** Calls fn whenever the background publishes a new status. */
export function onStatus(fn: (s: StatusView) => void): void {
  ext().storage.onChanged.addListener((changes, area) => {
    if (area === 'session' && changes.status?.newValue) fn(changes.status.newValue as StatusView);
  });
}
