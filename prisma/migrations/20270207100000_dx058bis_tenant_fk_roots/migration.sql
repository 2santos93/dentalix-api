-- DX-058-bis (DB-016): FK "tenantId" -> tenants(id) en las tres raíces que no
-- la tenían: patients, locations y location_schedules.
--
-- Las demás tablas de clínica ya tienen FK directa a tenants o cuelgan de una
-- de estas raíces por FK compuestas (tenantId, …) (SEC-004,
-- 20261015130000_tenant_composite_fks). Con la FK en las raíces, ninguna fila
-- de clínica puede apuntar a una clínica inexistente. audit_events se queda
-- sin FK a propósito (es evidencia; ver schema.prisma).
--
-- ON DELETE RESTRICT ON UPDATE CASCADE (lo que Prisma espera de
-- `onDelete: Restrict`): borrar una clínica exige borrar antes sus sedes,
-- horarios y pacientes. Ningún código de producción borra clínicas (la baja es
-- `deletedAt`); solo las limpiezas de los tests, ya adaptadas.
--
-- En dos pasos: aquí ADD … NOT VALID (solo valida las filas nuevas) y en
-- 20270207100100_dx058bis_tenant_fk_roots_validate el VALIDATE CONSTRAINT, que
-- recorre las existentes con SHARE UPDATE EXCLUSIVE sin bloquear escrituras.
--
-- row_security = off: o se ven todas las filas o la comprobación falla (nunca
-- 0 filas en silencio). DX-113/DX-134: el owner puede no ser superusuario ni
-- BYPASSRLS; sin FORCE mientras dura, de vuelta al final. tenants no tiene RLS.
SET LOCAL row_security = off;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "location_schedules" NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Pre-flight. Si alguna fila apunta a una clínica que no existe, se aborta con
-- el desglose por tabla antes de crear ninguna FK. NUNCA se borran ni se
-- reescriben datos: hay que revisarlos a mano, `prisma migrate resolve
-- --rolled-back 20270207100000_dx058bis_tenant_fk_roots` y reintentar.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad text := '';
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "patients" c
   WHERE NOT EXISTS (SELECT 1 FROM "tenants" t WHERE t."id" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  patients.tenantId: %s', n); END IF;

  SELECT count(*) INTO n FROM "locations" c
   WHERE NOT EXISTS (SELECT 1 FROM "tenants" t WHERE t."id" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  locations.tenantId: %s', n); END IF;

  SELECT count(*) INTO n FROM "location_schedules" c
   WHERE NOT EXISTS (SELECT 1 FROM "tenants" t WHERE t."id" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  location_schedules.tenantId: %s', n); END IF;

  IF bad <> '' THEN
    RAISE EXCEPTION 'DX-058-bis: hay filas de una clinica que no existe en tenants. No se crea ninguna FK ni se toca ningun dato. Filas huerfanas por tabla:%', bad
      USING HINT = 'Revisa esas filas a mano (su tenantId), marca la migracion con prisma migrate resolve --rolled-back 20270207100000_dx058bis_tenant_fk_roots y vuelve a ejecutar prisma migrate deploy.';
  END IF;
END $$;

ALTER TABLE "patients" ADD CONSTRAINT "patients_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "locations" ADD CONSTRAINT "locations_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;
ALTER TABLE "location_schedules" ADD CONSTRAINT "location_schedules_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

ALTER TABLE "location_schedules" FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;
ALTER TABLE "patients" FORCE ROW LEVEL SECURITY;
