-- DX-019-ter: relleno del logo congelado de los consentimientos firmados y
-- las indicaciones post-operatorias entregadas antes de esta versión. Sin él,
-- NULL («emitido sin logo») haría desaparecer el logo de todas sus
-- reimpresiones de hoy. Mismo mecanismo que DX-019-bis
-- (20261203090100_dx019b_clinic_logo_key_backfill).
--
-- Regla (decisión D5 de DX-019-bis): el logo vigente en el instante de la
-- firma o la entrega (`patient_consents."signedAt"`,
-- `post_op_instruction_deliveries."deliveredAt"`), reconstruido con la
-- auditoría de su clínica. Cada cambio del logo se audita en la misma
-- transacción que lo hace (`setLogo`, DX-019) como
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
-- deja leer pero hace esperar a las escrituras hasta el COMMIT). El UPDATE
-- solo escribe "clinicLogoKey" (test/clinic-logo-freeze-ter.int-spec.ts
-- compara el resto de la fila y el estado de los triggers al terminar).
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS le
-- aplica, así que recorre las clínicas y fija `app.current_tenant` en cada
-- una; así no se toma ACCESS EXCLUSIVE sobre `audit_events`, que escribe casi
-- cada petición. La clínica se limpia al final. `lock_timeout` solo acota la
-- espera de los bloqueos, no lo que dura el relleno (una sentencia por
-- clínica).
--
-- Idempotente: solo toca filas con la clave NULL, y lo que deja NULL es
-- exactamente lo que se emitió sin logo, así que repetirlo no cambia nada.
-- Despliegue escalonado: una réplica anterior que firme o entregue después de
-- este relleno deja NULL (se reimprimirá sin logo). Despliega con parada
-- única o, sin réplicas viejas, repite este fichero con psql y el owner.
-- Pasos en el README, «Logo congelado en documentos emitidos (DX-019-bis)».
BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "patient_consents" DISABLE TRIGGER "patient_consents_immutable";
ALTER TABLE "post_op_instruction_deliveries" DISABLE TRIGGER "post_op_instruction_deliveries_immutable";
DO $$
DECLARE
  t uuid;
  t_logo text;
BEGIN
  FOR t, t_logo IN SELECT "id", "logoUrl" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    WITH docs AS (
      SELECT 'CONSENT' AS kind, c."id", c."signedAt" AS at
        FROM public."patient_consents" c
       WHERE c."tenantId" = t AND c."clinicLogoKey" IS NULL
      UNION ALL
      SELECT 'POST_OP', d."id", d."deliveredAt"
        FROM public."post_op_instruction_deliveries" d
       WHERE d."tenantId" = t AND d."clinicLogoKey" IS NULL
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
    ), consents AS (
      UPDATE public."patient_consents" c
         SET "clinicLogoKey" = f.logo
        FROM frozen f
       WHERE f.kind = 'CONSENT' AND f.logo IS NOT NULL
         AND c."tenantId" = t AND c."id" = f."id"
    )
    UPDATE public."post_op_instruction_deliveries" d
       SET "clinicLogoKey" = f.logo
      FROM frozen f
     WHERE f.kind = 'POST_OP' AND f.logo IS NOT NULL
       AND d."tenantId" = t AND d."id" = f."id";
  END LOOP;
  PERFORM pg_catalog.set_config('app.current_tenant', '', true);
END
$$;
ALTER TABLE "patient_consents" ENABLE TRIGGER "patient_consents_immutable";
ALTER TABLE "post_op_instruction_deliveries" ENABLE TRIGGER "post_op_instruction_deliveries_immutable";
COMMIT;
