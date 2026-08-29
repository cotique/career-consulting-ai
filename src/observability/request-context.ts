import { AsyncLocalStorage } from 'node:async_hooks';

export interface RequestContext {
  requestId: string;
}

/**
 * Carries the request id from the middleware that assigns it to whatever needs
 * it later, without threading a parameter through every signature.
 *
 * `AsyncLocalStorage` rather than a module-level variable: the process handles
 * requests concurrently, so a shared variable would attribute one request's log
 * lines to another. It is the same trap as a shared database connection, and it
 * shows up only under load, which is when the logs matter most.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/** The id of the request being handled, or undefined outside a request. */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}
