// Message router: validates the envelope, dispatches to registered handlers
// and turns failures into { ok: false, error } responses. Feature modules
// register their own handlers.
import type { MessageType, Protocol, Response } from './messages';

export type Handler<K extends MessageType> = (req: Protocol[K]['req']) => Promise<Protocol[K]['res']>;

/** Thrown by handlers for invalid input; reported with its code. */
export class RequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RequestError';
  }
}

export class Router {
  private readonly handlers = new Map<string, (req: never) => Promise<unknown>>();

  register<K extends MessageType>(type: K, handler: Handler<K>): void {
    this.handlers.set(type, handler as (req: never) => Promise<unknown>);
  }

  has(type: string): boolean {
    return this.handlers.has(type);
  }

  async dispatch(message: unknown): Promise<Response<unknown>> {
    if (typeof message !== 'object' || message === null || typeof (message as { type?: unknown }).type !== 'string') {
      return { ok: false, error: { code: 'invalid_message', message: 'malformed message' } };
    }
    const handler = this.handlers.get((message as { type: string }).type);
    if (!handler) return { ok: false, error: { code: 'invalid_message', message: `unknown message type` } };
    try {
      return { ok: true, data: await handler(message as never) };
    } catch (e) {
      const code = typeof (e as { code?: unknown }).code === 'string' ? (e as { code: string }).code : 'internal';
      return { ok: false, error: { code, message: e instanceof Error ? e.message : String(e) } };
    }
  }

  /** Answers runtime messages from this extension's own pages only. */
  listen(runtime: typeof chrome.runtime): void {
    runtime.onMessage.addListener((message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => {
      if (sender.id !== runtime.id) return false;
      void this.dispatch(message).then(sendResponse);
      return true; // async response
    });
  }
}

/** Reads a required string field of a request. */
export function requireString(req: object, field: string, { allowEmpty = false } = {}): string {
  const v = (req as Record<string, unknown>)[field];
  if (typeof v !== 'string' || (!allowEmpty && v.trim() === '')) throw new RequestError('invalid_request', `${field} is required`);
  return v;
}
