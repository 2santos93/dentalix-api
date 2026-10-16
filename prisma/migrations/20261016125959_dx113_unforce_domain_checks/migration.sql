-- DX-113: el owner de las migraciones no es superusuario ni tiene BYPASSRLS
-- (Postgres gestionado). Con FORCE ROW LEVEL SECURITY ese owner está sujeto a
-- la RLS y, sin `app.current_tenant`, la migración siguiente
-- (20261016130000_domain_checks y 20261016131000_currency_fks)
-- fallan con `row_security = off` ("query would be affected by row-level security policy").
--
-- Se quita FORCE solo a las tablas que esa migración lee o escribe, y lo
-- restaura 20261016131001_dx113_reforce_domain_checks. Sin FORCE el owner ve todas las filas;
-- dentalix_app no es owner y sigue igual de sujeto a la RLS (FORCE solo
-- afecta al owner). En una BD que ya tenía aplicada la migración del medio,
-- esta y su pareja se aplican seguidas y la tabla queda como estaba. Si la
-- del medio falla, FORCE queda quitado hasta repetir el deploy: lo vigila
-- test/rls-catalog.int-spec.ts. Ver README, «Despliegue: roles de la BD».
SET LOCAL lock_timeout = '5s';

ALTER TABLE "dental_catalog_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plans" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "treatment_plan_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "payments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "payment_plans" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "installments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "appointments" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "inventory_items" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "inventory_movements" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "tooth_records" NO FORCE ROW LEVEL SECURITY;
