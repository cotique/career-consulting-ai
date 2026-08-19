-- Sign-in is the one operation that cannot run under RLS: it looks up an
-- identity in order to discover *who* the caller is, so there is no
-- app.current_user_id to scope by yet. Two ways to resolve that:
--
--   (a) give the running app a superuser connection for auth — which puts an
--       RLS-bypassing connection inside the app process, reachable from any
--       code path that later gets added;
--   (b) expose exactly this one operation as a SECURITY DEFINER function that
--       app_user may execute, and nothing more.
--
-- (b) is what this migration does. The privilege escalation is scoped to one
-- auditable function that only ever touches users/auth_identities, instead of
-- being an ambient capability of the whole application.
--
-- T42 rule enforced here as well as in application code: the lookup is by
-- (provider, external_id) only. An unknown subject creates a NEW account even
-- if p_email matches an existing user — auto-linking on email is an account
-- takeover path (Microsoft's email claim is not reliably verified, and email
-- addresses change hands). p_email is stored for display only.

CREATE OR REPLACE FUNCTION auth_find_or_create_user(
  p_provider auth_provider,
  p_external_id text,
  p_email text DEFAULT NULL,
  p_name text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
-- Fixed search_path: without it, a caller-controlled search_path could shadow
-- the tables this function writes to.
SET search_path = public, pg_temp
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT user_id INTO v_user_id
  FROM auth_identities
  WHERE provider = p_provider AND external_id = p_external_id;

  IF v_user_id IS NOT NULL THEN
    RETURN v_user_id;
  END IF;

  INSERT INTO users (name) VALUES (p_name) RETURNING id INTO v_user_id;

  INSERT INTO auth_identities (user_id, provider, external_id, email)
  VALUES (v_user_id, p_provider, p_external_id, p_email);

  RETURN v_user_id;
END;
$$;

REVOKE ALL ON FUNCTION auth_find_or_create_user(auth_provider, text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION auth_find_or_create_user(auth_provider, text, text, text) TO app_user;
