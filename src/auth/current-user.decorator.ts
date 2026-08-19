import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** The authenticated user's id, set by AuthGuard. */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): string => {
  const req = ctx.switchToHttp().getRequest<Request>();
  if (!req.userId) {
    // Reaching a handler without a user means the route is missing AuthGuard —
    // a wiring bug, not a runtime condition, so fail loudly rather than
    // returning undefined and letting a query run unscoped.
    throw new Error('CurrentUser used on a route without AuthGuard.');
  }
  return req.userId;
});
