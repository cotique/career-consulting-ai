/**
 * The one connection in the system with no RLS user context.
 *
 * Sign-in has to read an identity *before* it knows who the caller is, so there
 * is no `app.current_user_id` for RLS to scope by. Everything else takes a
 * scoped `Database` from `withUserContext(pool, …)`.
 *
 * The name is deliberately awkward: injecting it anywhere else should read as
 * obviously wrong. It lives in its own file so that `identity.service.ts` and
 * `auth.module.ts` can both reach it without importing each other — a cycle
 * there would leave the token undefined when the decorator is evaluated.
 */
export const UNSCOPED_DB_SIGN_IN_ONLY = 'UNSCOPED_DB_SIGN_IN_ONLY';
