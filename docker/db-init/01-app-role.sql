-- App role: non-superuser (RLS-enforced). The app connects as this at runtime.
CREATE ROLE dentalix_app WITH LOGIN PASSWORD 'dentalix_app';
GRANT USAGE ON SCHEMA public TO dentalix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dentalix_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dentalix_app;
-- Future tables/sequences created by the owner (migrations) auto-grant to the app role:
ALTER DEFAULT PRIVILEGES FOR ROLE dentalix IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dentalix_app;
ALTER DEFAULT PRIVILEGES FOR ROLE dentalix IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dentalix_app;
