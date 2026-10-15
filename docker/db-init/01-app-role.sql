-- App role: non-superuser (RLS-enforced). The app connects as this at runtime.
-- SOLO DESARROLLO/CI: la contraseña es pública. En producción crea el rol con
-- una contraseña generada (`openssl rand -hex 24`); la API se niega a arrancar
-- con NODE_ENV=production si DATABASE_URL/DIRECT_URL usan una de ejemplo.
CREATE ROLE dentalix_app WITH LOGIN PASSWORD 'dentalix_app';
GRANT USAGE ON SCHEMA public TO dentalix_app;
-- No-op at init time (schema is empty pre-migration); real grants come from the
-- ALTER DEFAULT PRIVILEGES below as migrations create tables. Kept for clarity/idempotence.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dentalix_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dentalix_app;
-- Future tables/sequences created by the owner (migrations) auto-grant to the app role:
ALTER DEFAULT PRIVILEGES FOR ROLE dentalix IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO dentalix_app;
ALTER DEFAULT PRIVILEGES FOR ROLE dentalix IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO dentalix_app;
