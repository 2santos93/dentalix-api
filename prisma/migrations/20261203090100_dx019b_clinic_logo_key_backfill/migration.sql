-- DX-019-bis (B): relleno ÚNICO del logo congelado de las recetas y las
-- aceptaciones firmadas ya emitidas. Sin él, NULL («emitido sin logo») haría
-- desaparecer el logo de todas las reimpresiones de hoy.
--
-- Regla (decisión D5): el logo vigente en el instante de la emisión
-- (`prescriptions."issuedAt"`, `treatment_plan_acceptances."acceptedAt"`),
-- reconstruido con la auditoría de su clínica. Cada cambio del logo se audita
-- en la misma transacción que lo hace (`setLogo`, DX-019) como
-- `resourceType = 'CLINIC_SETTINGS'`, `metadata.reason = 'CLINIC_LOGO'` y
-- `metadata.configChange = {before: {logo}, after: {logo}}` (la clave o null):
--   1. el `after.logo` del ÚLTIMO evento con `occurredAt` <= la emisión;
--   2. si no hay, el `before.logo` del PRIMER evento posterior;
--   3. si la clínica no tiene ningún evento, su logo actual (`tenants."logoUrl"`):
--      antes de DX-019 nada escribía el logo, así que no ha cambiado.
-- Un null del evento cuenta (el logo estaba quitado): no se pasa al siguiente
-- paso. Lo que `clinicLogoPublicUrl` no sabe pintar queda NULL (es lo que se
-- imprime hoy), así que el relleno cumple el CHECK NOT VALID de la migración
-- anterior. Solo se tocan las filas que acaban con logo; las demás siguen NULL.
--
-- Las dos tablas son inmutables por trigger. Se desactivan SOLO sus triggers
-- `*_immutable`, SOLO alrededor del UPDATE y en la MISMA transacción: un fallo
-- revierte relleno y desactivación juntos, y nadie más ve nunca el trigger
-- desactivado (ALTER TABLE … DISABLE TRIGGER toma SHARE ROW EXCLUSIVE, que
-- deja leer pero hace esperar a las escrituras hasta el COMMIT). Precedentes:
-- 20261022110000_dx232_clinical_entry_location y
-- 20261021120000_dx236_reference_diagnosis_snapshot. El UPDATE solo escribe
-- "clinicLogoKey" (test/clinic-logo-freeze.int-spec.ts compara el resto de la
-- fila y el estado de los triggers al terminar).
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS le
-- aplica, así que recorre las clínicas y fija `app.current_tenant` en cada
-- una (como 20261128090100_dx502_plan_item_catalog_currency_backfill); así no
-- se toma ACCESS EXCLUSIVE sobre `audit_events`, que escribe casi cada
-- petición. La clínica se limpia al final. `lock_timeout` solo acota la espera
-- de los bloqueos, no lo que dura el relleno (una sentencia por clínica).
--
-- Despliegue escalonado: una réplica anterior que emita después de este
-- relleno deja NULL (se reimprimirá sin logo). Para evitarlo, despliega con
-- parada única o, sin réplicas viejas, repite este fichero con psql y el owner
-- (idempotente: solo filas con la clave NULL). Pasos en el README, «Logo
-- congelado en documentos emitidos (DX-019-bis)».
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "prescriptions" DISABLE TRIGGER "prescriptions_immutable";
ALTER TABLE "treatment_plan_acceptances" DISABLE TRIGGER "treatment_plan_acceptances_immutable";
DO $$
DECLARE
  t uuid;
  t_logo text;
BEGIN
  FOR t, t_logo IN SELECT "id", "logoUrl" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    WITH docs AS (
      SELECT 'PRESCRIPTION' AS kind, p."id", p."issuedAt" AS at
        FROM public."prescriptions" p
       WHERE p."tenantId" = t AND p."clinicLogoKey" IS NULL
      UNION ALL
      SELECT 'ACCEPTANCE', a."id", a."acceptedAt"
        FROM public."treatment_plan_acceptances" a
       WHERE a."tenantId" = t AND a."clinicLogoKey" IS NULL
    ), frozen AS (
      SELECT d.kind, d."id", CASE
               WHEN (v.logo ~ '^logos/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
                     AND pg_catalog.strpos(v.logo, '..') = 0)
                 OR v.logo ~* '^https?://'
               THEN v.logo
             END AS logo
        FROM docs d
        LEFT JOIN LATERAL (
          SELECT true AS found,
                 e."metadata" #>> '{configChange,after,logo}' AS logo
            FROM public."audit_events" e
           WHERE e."tenantId" = t
             AND e."resourceType" = 'CLINIC_SETTINGS'
             AND e."metadata" ->> 'reason' = 'CLINIC_LOGO'
             AND e."occurredAt" <= d.at
           ORDER BY e."occurredAt" DESC, e."id" DESC
           LIMIT 1
        ) prev ON true
        LEFT JOIN LATERAL (
          SELECT true AS found,
                 e."metadata" #>> '{configChange,before,logo}' AS logo
            FROM public."audit_events" e
           WHERE e."tenantId" = t
             AND e."resourceType" = 'CLINIC_SETTINGS'
             AND e."metadata" ->> 'reason' = 'CLINIC_LOGO'
             AND e."occurredAt" > d.at
           ORDER BY e."occurredAt" ASC, e."id" ASC
           LIMIT 1
        ) next ON true
        -- `found` distingue «sin evento» de «evento con el logo quitado» (null).
        CROSS JOIN LATERAL (
          SELECT CASE
                   WHEN prev.found THEN prev.logo
                   WHEN next.found THEN next.logo
                   ELSE t_logo
                 END AS logo
        ) v
    ), rx AS (
      UPDATE public."prescriptions" p
         SET "clinicLogoKey" = f.logo
        FROM frozen f
       WHERE f.kind = 'PRESCRIPTION' AND f.logo IS NOT NULL
         AND p."tenantId" = t AND p."id" = f."id"
    )
    UPDATE public."treatment_plan_acceptances" a
       SET "clinicLogoKey" = f.logo
      FROM frozen f
     WHERE f.kind = 'ACCEPTANCE' AND f.logo IS NOT NULL
       AND a."tenantId" = t AND a."id" = f."id";
  END LOOP;
  PERFORM pg_catalog.set_config('app.current_tenant', '', true);
END
$$;
ALTER TABLE "prescriptions" ENABLE TRIGGER "prescriptions_immutable";
ALTER TABLE "treatment_plan_acceptances" ENABLE TRIGGER "treatment_plan_acceptances_immutable";
COMMIT;
