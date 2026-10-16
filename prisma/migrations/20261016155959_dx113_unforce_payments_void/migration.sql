-- DX-113: el owner de las migraciones no es superusuario ni tiene BYPASSRLS
-- (Postgres gestionado). Con FORCE ROW LEVEL SECURITY ese owner está sujeto a
-- la RLS y, sin `app.current_tenant`, la migración siguiente
-- (20261016160000_payment_void_audit)
-- haría su UPDATE de voidedAt sobre 0 filas: los abonos anulados quedarían sin fecha de anulación.
--
-- Se quita FORCE solo a las tablas que esa migración lee o escribe, y lo
-- restaura 20261016160001_dx113_reforce_payments_void. Sin FORCE el owner ve todas las filas;
-- dentalix_app no es owner y sigue igual de sujeto a la RLS (FORCE solo
-- afecta al owner). En una BD que ya tenía aplicada la migración del medio,
-- esta y su pareja se aplican seguidas y la tabla queda como estaba. Si la
-- del medio falla, FORCE queda quitado hasta repetir el deploy: lo vigila
-- test/rls-catalog.int-spec.ts. Ver README, «Despliegue: roles de la BD».
SET LOCAL lock_timeout = '5s';

ALTER TABLE "payments" NO FORCE ROW LEVEL SECURITY;
