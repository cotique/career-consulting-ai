import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { requestContext } from './request-context';

export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * An inbound id is accepted so a caller can tie its own logs to ours, but it is
 * never trusted as given: the header is attacker-controlled and ends up in log
 * lines, where a newline would let a caller forge log entries and a long value
 * would flood them. So it is bounded and restricted to characters that cannot
 * break a line, and anything else is replaced rather than rejected — refusing
 * the request would turn a cosmetic problem into an outage.
 */
const SAFE_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function requestIdMiddleware(req: Request, res: Response, next: NextFunction): void {
  const supplied = req.header(REQUEST_ID_HEADER);
  const requestId = supplied && SAFE_ID.test(supplied) ? supplied : randomUUID();

  // Echoed back so a person reporting a problem has something to quote, and so
  // the id exists even for a response that never reaches a log line.
  res.setHeader(REQUEST_ID_HEADER, requestId);

  requestContext.run({ requestId }, () => next());
}
