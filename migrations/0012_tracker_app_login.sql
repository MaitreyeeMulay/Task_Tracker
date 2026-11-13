-- 0012: M6 login role for the app and worker on AWS.
-- Additive: one new role. Previous code doesn't use it.
--
-- tracker_app logs in with IAM database authentication (rds_iam), so it has
-- no password. It holds no privileges of its own (NOINHERIT): every query must
-- first SET LOCAL ROLE to one of the narrow app roles, which is what the code
-- already does. Outside RDS the rds_iam role doesn't exist and is skipped.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tracker_app') THEN
    CREATE ROLE tracker_app LOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'rds_iam') THEN
    GRANT rds_iam TO tracker_app;
  END IF;
END
$$;

GRANT app_rw, app_ingest, app_worker, app_auth TO tracker_app;
