-- SEC-009: dominios personalizados sin "squatting" y con caducidad.
--
-- Hasta aquí el host era único entre TODAS las filas vivas
-- (tenant_domains_host_key, WHERE "deletedAt" IS NULL, de
-- 20260731164000_tenant_domain_partial_unique), también las PENDING, que no
-- caducaban ni se podían borrar: una clínica podía reservar el dominio de otra
-- y bloquearla con 409 para siempre. Ahora:
--
--  * tenant_domains_verified_host_key: el host es único solo entre los
--    VERIFIED vivos. Varias clínicas pueden tenerlo en PENDING; lo gana la
--    primera que demuestra el control del DNS (TXT) y es exactamente lo que
--    enruta TenantResolverService (status = 'VERIFIED' AND "deletedAt" IS NULL).
--  * tenant_domains_tenant_host_key: dentro de UNA clínica, un host una sola
--    vez entre los vivos (respaldo de la comprobación del caso de uso ante dos
--    altas a la vez).
--  * tenant_domains_host_idx: filas vivas de un host en todas las clínicas
--    (al verificar se invalidan los PENDING ajenos del mismo host).
--  * "expiresAt": hasta cuándo se puede verificar un PENDING (72 h). Las
--    PENDING existentes caducan a las 72 h de su alta (las antiguas, ya). Default
--    de la BD para que el código anterior, durante el despliegue, inserte con
--    caducidad aunque no la conozca.
--  * "lastCheckedAt", "failedChecks", "disabledAt": re-verificación periódica
--    de los VERIFIED (tarea programada domains.recheck).
--
-- Compatible hacia atrás y sin pérdida: solo añade columnas (nulas o con
-- default) e índices, y el índice nuevo de host es estrictamente más laxo que
-- el que sustituye. Ningún dato se borra ni se reescribe salvo "expiresAt" de
-- las PENDING. tenant_domains NO tiene RLS (ruteo previo a conocer el tenant):
-- el owner ve todas las filas, también en un Postgres gestionado sin
-- superusuario (DX-113).
--
-- Locks: SHARE ROW EXCLUSIVE (deja leer —el ruteo sigue funcionando— y
-- bloquea escrituras) para que nadie cuele una fila duplicada entre la
-- comprobación previa y los CREATE UNIQUE INDEX. lock_timeout: si una
-- transacción larga retiene la tabla, la migración falla limpia y basta con
-- reintentar el deploy. La tabla es pequeña (un puñado de filas por clínica):
-- sin CONCURRENTLY.

SET LOCAL lock_timeout = '10s';
LOCK TABLE "tenant_domains" IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- 1. Pre-flight: duplicados que romperían los índices únicos nuevos. NUNCA se
--    borran ni se reescriben datos: se aborta con el desglose para revisarlos
--    a mano, `prisma migrate resolve --rolled-back` y reintentar.
--    (Con el índice anterior —host único entre los vivos— ninguno de los dos
--    casos puede darse; se comprueba igualmente por si hubo SQL manual.)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad text := '';
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM (
    SELECT 1 FROM "tenant_domains"
     WHERE "status" = 'VERIFIED' AND "deletedAt" IS NULL
     GROUP BY "host" HAVING count(*) > 1
  ) d;
  IF n > 0 THEN bad := bad || format(E'\n  hosts VERIFIED vivos repetidos: %s', n); END IF;

  SELECT count(*) INTO n FROM (
    SELECT 1 FROM "tenant_domains"
     WHERE "deletedAt" IS NULL
     GROUP BY "tenantId", "host" HAVING count(*) > 1
  ) d;
  IF n > 0 THEN bad := bad || format(E'\n  (tenantId, host) vivos repetidos: %s', n); END IF;

  IF bad <> '' THEN
    RAISE EXCEPTION 'SEC-009: hay dominios duplicados que romperían los índices únicos nuevos. No se crea ningún índice ni se toca ningún dato. Grupos duplicados:%', bad
      USING HINT = 'Revisa esas filas de tenant_domains a mano (soft-delete con "deletedAt" de las sobrantes), marca la migración con prisma migrate resolve --rolled-back 20261017233300_sec009_tenant_domain_verified_unique y vuelve a ejecutar prisma migrate deploy.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Columnas nuevas. "expiresAt" se añade sin default (no reescribe la
--    tabla), se rellena para las PENDING y luego recibe el default.
-- ---------------------------------------------------------------------------
ALTER TABLE "tenant_domains"
  ADD COLUMN "expiresAt" TIMESTAMP(3),
  ADD COLUMN "lastCheckedAt" TIMESTAMP(3),
  ADD COLUMN "failedChecks" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "disabledAt" TIMESTAMP(3);

UPDATE "tenant_domains"
   SET "expiresAt" = "createdAt" + interval '72 hours'
 WHERE "status" = 'PENDING';

ALTER TABLE "tenant_domains"
  ALTER COLUMN "expiresAt" SET DEFAULT (CURRENT_TIMESTAMP + '72:00:00'::interval),
  ADD CONSTRAINT "tenant_domains_failed_checks_nonneg" CHECK ("failedChecks" >= 0);

-- ---------------------------------------------------------------------------
-- 3. Índices. Los nuevos se crean ANTES de retirar el viejo: la tabla nunca
--    queda sin único de host.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "tenant_domains_verified_host_key"
  ON "tenant_domains" ("host")
  WHERE "status" = 'VERIFIED' AND "deletedAt" IS NULL;

CREATE UNIQUE INDEX "tenant_domains_tenant_host_key"
  ON "tenant_domains" ("tenantId", "host")
  WHERE "deletedAt" IS NULL;

CREATE INDEX "tenant_domains_host_idx"
  ON "tenant_domains" ("host")
  WHERE "deletedAt" IS NULL;

DROP INDEX "tenant_domains_host_key";
