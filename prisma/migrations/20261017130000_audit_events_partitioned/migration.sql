-- DX-102 (T-BD-4; hallazgos DB-020, DB-021, DB-026): audit_events a escala.
--
-- Cambios:
--   audit_events            pasa a tabla particionada por RANGE("occurredAt"),
--                           una partición por mes (UTC, como escribe Prisma),
--                           PK ("id","occurredAt") (la clave de partición
--                           tiene que estar en la PK) y una partición DEFAULT de
--                           seguridad: un evento de un mes sin partición no
--                           rompe la petición, cae en DEFAULT.
--   particiones             desde el mes del evento más antiguo hasta 24 meses
--                           por delante. La API asegura el horizonte al
--                           arrancar y cada día (audit_events_ensure_partitions).
--   RLS                     ENABLE + FORCE y política tenant_isolation en el
--                           padre y en CADA partición (por si alguien consulta
--                           una partición directamente).
--   append-only             además del trigger de DX-009, por PRIVILEGIO: nadie
--                           salvo el owner tiene UPDATE, DELETE, TRUNCATE ni
--                           TRIGGER en el padre ni en las particiones (42501).
--   índices                 (tenantId, occurredAt DESC, id DESC) para el cursor
--                           keyset; paciente y actor con el mismo orden; y uno
--                           PARCIAL por valor de action (salvo VIEW) y de
--                           resourceType: la igualdad de enums no es LEAKPROOF
--                           y bajo RLS no puede ser condición de índice, pero la
--                           implicación del predicado parcial sí funciona
--                           (DB-021/DB-022). Cada fila entra en un solo parcial
--                           de cada familia: suman lo que un índice completo.
--   purga                   audit_events_purge(meses): DETACH + DROP de las
--                           particiones COMPLETAS más antiguas que la
--                           retención; nunca por debajo de 180 meses (15 años,
--                           la conservación de la historia clínica). Sin
--                           EXECUTE para la app: la ejecuta el owner
--                           (`npm run audit:purge`). No dispara triggers de
--                           fila: el append-only sigue protegiendo lo vivo.
--
-- Datos: la tabla de DX-009 se renombra, sus filas se copian tal cual a la
-- nueva (cada una a su partición), se comprueba el conteo y se elimina. Todo
-- en la transacción de la migración y con ACCESS EXCLUSIVE sobre la tabla
-- vieja: ningún evento entra a mitad de la copia. Pensado para el estado
-- actual (tabla vacía o pequeña antes del primer despliegue); con millones de
-- filas, ver el runbook del informe DX-102.
--
-- Compatible hacia atrás: mismo nombre, columnas, tipos, CHECK, política y
-- triggers; el código de DX-009 sigue funcionando (solo cambia la forma del
-- cursor y el id pasa a uuid v7 en Prisma, ambos compatibles).
--
-- Reversible: crear una tabla sin particionar e INSERT ... SELECT desde esta.

SET LOCAL lock_timeout = '10s';
-- row_security = off: si alguna lectura o escritura de la copia quedara sujeta
-- a RLS (owner sin superusuario ni BYPASSRLS con la tabla en FORCE), falla
-- en vez de leer 0 filas en silencio (ver 20261016130000_domain_checks).
SET LOCAL row_security = off;

-- ---------------------------------------------------------------------------
-- 1. Apartar la tabla de DX-009 (mismos nombres de índice que la nueva).
-- ---------------------------------------------------------------------------
LOCK TABLE "audit_events" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "audit_events" RENAME TO "audit_events_dx009";
ALTER TABLE "audit_events_dx009" RENAME CONSTRAINT "audit_events_pkey" TO "audit_events_dx009_pkey";
ALTER INDEX "audit_events_tenantId_occurredAt_idx" RENAME TO "audit_events_dx009_t_o_idx";
ALTER INDEX "audit_events_tenantId_patientId_occurredAt_idx" RENAME TO "audit_events_dx009_t_p_o_idx";
ALTER INDEX "audit_events_tenantId_actorUserId_occurredAt_idx" RENAME TO "audit_events_dx009_t_a_o_idx";
-- La tabla vieja tiene RLS FORCE (DX-009): sin esto, un owner que no es
-- superusuario (producción) no ve ninguna fila y la copia saldría vacía. Se
-- borra al final de esta misma transacción.
ALTER TABLE "audit_events_dx009" NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Tabla particionada (mismas columnas y CHECK que DX-009).
-- ---------------------------------------------------------------------------
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID,
    "actorUserId" UUID,
    "actorRole" "ClinicRole",
    "action" "AuditAction" NOT NULL,
    "resourceType" "AuditResourceType" NOT NULL,
    "resourceId" UUID,
    "patientId" UUID,
    "requestId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id", "occurredAt"),
    CONSTRAINT "audit_events_metadata_object_check" CHECK (jsonb_typeof("metadata") = 'object'),
    CONSTRAINT "audit_events_actor_check" CHECK ("actorUserId" IS NOT NULL OR "action" = 'LOGIN_FAILED')
) PARTITION BY RANGE ("occurredAt");

-- ---------------------------------------------------------------------------
-- 3. Índices (en el padre: Postgres los crea en cada partición).
-- ---------------------------------------------------------------------------
CREATE INDEX "audit_events_tenantId_occurredAt_id_idx"
  ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC);
CREATE INDEX "audit_events_tenantId_patientId_occurredAt_id_idx"
  ON "audit_events"("tenantId", "patientId", "occurredAt" DESC, "id" DESC);
CREATE INDEX "audit_events_tenantId_actorUserId_occurredAt_id_idx"
  ON "audit_events"("tenantId", "actorUserId", "occurredAt" DESC, "id" DESC);

-- Parciales por valor de enum (ver cabecera). VIEW no lleva el suyo: es la
-- acción mayoritaria y el índice por tiempo ya la sirve. Un valor de enum
-- nuevo necesita su índice en la misma migración (lo vigila
-- test/audit-events-partitions.int-spec.ts).
DO $$
DECLARE v text;
BEGIN
  FOR v IN SELECT unnest(enum_range(NULL::"AuditAction"))::text LOOP
    CONTINUE WHEN v = 'VIEW';
    EXECUTE format(
      'CREATE INDEX %I ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC) WHERE "action" = %L',
      'audit_events_action_' || lower(v) || '_idx', v);
  END LOOP;
  FOR v IN SELECT unnest(enum_range(NULL::"AuditResourceType"))::text LOOP
    EXECUTE format(
      'CREATE INDEX %I ON "audit_events"("tenantId", "occurredAt" DESC, "id" DESC) WHERE "resourceType" = %L',
      'audit_events_resource_' || lower(v) || '_idx', v);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Append-only: los triggers de DX-009 en el padre. El de fila se clona en
--    cada partición; el de TRUNCATE (de sentencia) no, lo pone
--    dx_audit_events_harden en cada una.
-- ---------------------------------------------------------------------------
CREATE TRIGGER "audit_events_append_only"
  BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION "dx_forbid_audit_mutation"();

CREATE TRIGGER "audit_events_no_truncate"
  BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "dx_forbid_audit_mutation"();

ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "audit_events"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- ---------------------------------------------------------------------------
-- 5. Endurecer una relación de audit_events (padre o partición): RLS forzada
--    con la misma política, trigger de TRUNCATE y fuera UPDATE, DELETE,
--    TRUNCATE y TRIGGER para todo rol que no sea el owner. ALTER DEFAULT
--    PRIVILEGES concede UPDATE/DELETE al rol de la app en cada tabla nueva:
--    esto lo deshace partición a partición, sea cual sea el nombre del rol.
-- ---------------------------------------------------------------------------
CREATE FUNCTION dx_audit_events_harden(p_rel regclass) RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  g record;
BEGIN
  EXECUTE format('ALTER TABLE %s ENABLE ROW LEVEL SECURITY', p_rel);
  EXECUTE format('ALTER TABLE %s FORCE ROW LEVEL SECURITY', p_rel);
  IF NOT EXISTS (SELECT 1 FROM pg_policy
                 WHERE polrelid = p_rel AND polname = 'tenant_isolation') THEN
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %s '
      'USING ("tenantId" = current_setting(''app.current_tenant'', true)::uuid) '
      'WITH CHECK ("tenantId" = current_setting(''app.current_tenant'', true)::uuid)',
      p_rel);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger
                 WHERE tgrelid = p_rel AND tgname = 'audit_events_no_truncate') THEN
    EXECUTE format(
      'CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON %s '
      'FOR EACH STATEMENT EXECUTE FUNCTION dx_forbid_audit_mutation()', p_rel);
  END IF;
  FOR g IN
    SELECT DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC'
                         ELSE quote_ident(r.rolname) END AS who
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(c.relacl) a
    LEFT JOIN pg_roles r ON r.oid = a.grantee
    WHERE c.oid = p_rel
      AND a.grantee <> c.relowner
      AND a.privilege_type IN ('UPDATE', 'DELETE', 'TRUNCATE', 'TRIGGER')
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, TRIGGER ON %s FROM %s',
                   p_rel, g.who);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- 6. Crear la partición de un mes (idempotente). Si DEFAULT ya tiene filas de
--    ese mes, Postgres no deja crearla: avisa (WARNING) y no falla; los
--    eventos siguen entrando en DEFAULT (runbook en el informe DX-102).
--    Solo el owner: la app pasa por audit_events_ensure_partitions.
-- ---------------------------------------------------------------------------
CREATE FUNCTION dx_audit_events_create_partition(p_month date) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_start timestamp := date_trunc('month', p_month)::timestamp;
  v_end timestamp := date_trunc('month', p_month)::timestamp + interval '1 month';
  v_name text := 'audit_events_p' || to_char(date_trunc('month', p_month), 'YYYYMM');
BEGIN
  IF to_regclass(format('public.%I', v_name)) IS NOT NULL THEN
    RETURN false;
  END IF;
  BEGIN
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.audit_events FOR VALUES FROM (%L) TO (%L)',
      v_name, v_start, v_end);
  EXCEPTION
    WHEN duplicate_table THEN
      RETURN false;
    WHEN check_violation THEN
      RAISE WARNING 'audit_events: la partición DEFAULT tiene eventos de %; no se crea % (runbook DX-102)',
        to_char(v_start, 'YYYY-MM'), v_name;
      RETURN false;
  END;
  PERFORM dx_audit_events_harden(format('public.%I', v_name)::regclass);
  RETURN true;
END;
$$;

-- Horizonte de particiones: el mes actual (UTC) y los p_months_ahead
-- siguientes. Devuelve cuántas creó (0 si ya estaban: idempotente). Un lock
-- consultivo serializa a varias réplicas arrancando a la vez. Acotado a 36
-- meses: la app no puede crear particiones arbitrarias.
CREATE FUNCTION audit_events_ensure_partitions(p_months_ahead integer DEFAULT 12)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_first date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  v_created integer := 0;
  i integer;
BEGIN
  IF p_months_ahead IS NULL OR p_months_ahead < 0 OR p_months_ahead > 36 THEN
    RAISE EXCEPTION 'audit_events_ensure_partitions: meses fuera de 0..36'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('dx_audit_events_partitions'));
  FOR i IN 0..p_months_ahead LOOP
    IF dx_audit_events_create_partition((v_first + make_interval(months => i))::date) THEN
      v_created := v_created + 1;
    END IF;
  END LOOP;
  RETURN v_created;
END;
$$;

-- ---------------------------------------------------------------------------
-- 7. Purga por partición completa. Corte = p_now − p_retention_months; cae
--    cada partición mensual cuyo FIN es <= corte (entera más antigua que la
--    retención). DEFAULT nunca se purga. DETACH + DROP no dispara triggers de
--    fila y no deja bloat ni WAL de un DELETE masivo. p_dry_run solo lista.
--    Mínimo legal en la propia BD: 180 meses (ver informe DX-102).
-- ---------------------------------------------------------------------------
CREATE FUNCTION audit_events_purge(
  p_retention_months integer,
  p_now timestamp DEFAULT (now() AT TIME ZONE 'UTC'),
  p_dry_run boolean DEFAULT false
)
RETURNS TABLE(partition_name text, range_start timestamp, range_end timestamp)
LANGUAGE plpgsql
SET search_path = public, pg_temp
SET lock_timeout = '5s'
AS $$
DECLARE
  v_cutoff timestamp;
  p record;
BEGIN
  IF p_retention_months IS NULL OR p_retention_months < 180 THEN
    RAISE EXCEPTION 'audit_events_purge: la retención mínima es de 180 meses (15 años, historia clínica); se pidió %',
      p_retention_months USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_cutoff := p_now - make_interval(months => p_retention_months);
  PERFORM pg_advisory_xact_lock(hashtext('dx_audit_events_partitions'));
  FOR p IN
    SELECT c.oid::regclass AS rel, c.relname::text AS name,
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'FROM \(''([^'']+)''\)'))[1]::timestamp AS lo,
           (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \(''([^'']+)''\)'))[1]::timestamp AS hi
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.audit_events'::regclass
      AND pg_get_expr(c.relpartbound, c.oid) <> 'DEFAULT'
    ORDER BY 3
  LOOP
    CONTINUE WHEN p.hi IS NULL OR p.hi > v_cutoff;
    partition_name := p.name;
    range_start := p.lo;
    range_end := p.hi;
    IF NOT p_dry_run THEN
      EXECUTE format('ALTER TABLE public.audit_events DETACH PARTITION %s', p.rel);
      EXECUTE format('DROP TABLE %s', p.rel);
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION dx_audit_events_harden(regclass) FROM PUBLIC;
REVOKE ALL ON FUNCTION dx_audit_events_create_partition(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_events_ensure_partitions(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION audit_events_purge(integer, timestamp, boolean) FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- 8. DEFAULT, particiones (desde el evento más antiguo hasta +24 meses) y
--    endurecimiento del padre.
-- ---------------------------------------------------------------------------
CREATE TABLE "audit_events_default" PARTITION OF "audit_events" DEFAULT;
SELECT dx_audit_events_harden('public.audit_events_default'::regclass);

SELECT dx_audit_events_create_partition(m::date)
FROM generate_series(
  date_trunc('month', LEAST(
    (SELECT min("occurredAt") FROM "audit_events_dx009"),
    now() AT TIME ZONE 'UTC')),
  date_trunc('month', now() AT TIME ZONE 'UTC') + interval '24 months',
  interval '1 month') AS m;

SELECT dx_audit_events_harden('public.audit_events'::regclass);

-- ---------------------------------------------------------------------------
-- 9. Copia sin pérdida y retirada de la tabla de DX-009. Durante la copia
--    el padre va sin FORCE para que el owner (sin superusuario en
--    producción) pueda escribir filas de todas las clínicas; vuelve a FORCE
--    antes de terminar la transacción, así que nadie lo ve sin forzar.
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_events" NO FORCE ROW LEVEL SECURITY;

INSERT INTO "audit_events"
  ("id", "tenantId", "locationId", "actorUserId", "actorRole", "action",
   "resourceType", "resourceId", "patientId", "requestId", "ip", "userAgent",
   "occurredAt", "metadata")
SELECT "id", "tenantId", "locationId", "actorUserId", "actorRole", "action",
       "resourceType", "resourceId", "patientId", "requestId", "ip", "userAgent",
       "occurredAt", "metadata"
FROM "audit_events_dx009";

DO $$
DECLARE
  v_old bigint;
  v_new bigint;
BEGIN
  SELECT count(*) INTO v_old FROM "audit_events_dx009";
  SELECT count(*) INTO v_new FROM "audit_events";
  IF v_old <> v_new THEN
    RAISE EXCEPTION 'DX-102: la copia de audit_events no cuadra (% filas antes, % después)', v_old, v_new;
  END IF;
END;
$$;

DROP TABLE "audit_events_dx009";
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 10. Grants: la app lee e inserta por el padre y asegura el horizonte de
--     particiones; NO purga ni crea meses arbitrarios. En una BD cuyo rol de
--     la app tenga otro nombre, concede lo mismo a mano (README).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT SELECT, INSERT ON "audit_events" TO dentalix_app;
    GRANT EXECUTE ON FUNCTION audit_events_ensure_partitions(integer) TO dentalix_app;
  END IF;
END;
$$;
