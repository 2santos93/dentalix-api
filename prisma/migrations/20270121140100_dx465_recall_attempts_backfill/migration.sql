-- DX-465: el estado del ciclo de cada recall desde sus contactos existentes,
-- por clínica, sin DDL (molde de 20261212090100).
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra una clínica. Sin NO FORCE:
-- con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS le aplica, así
-- que fija `app.current_tenant` en cada clínica.
--
-- El ciclo actual de un recall son sus contactos desde el día de su base
-- ("lastDoneAt": lo anterior es de otro control). Dentro de él, el último
-- «Agendó» o «Rechaza» lo cierra; lo de después son los intentos:
--   "attemptCount"  los contactos posteriores al último cierre (o todos);
--   "lastAttemptAt" el más reciente de ellos; sin ninguno, el del «Rechaza»
--                   que cerró (un «Agendó» lo deja en NULL);
--   "skipUntil"     si el último es un «Rechaza»: el vencimiento siguiente
--                   ("dueAt" + el intervalo del recall);
--   "callbackOn"    NULL: los «Llamar luego» anteriores no tenían fecha, así
--                   que ocultan los días de la sede como los demás;
--   "cycleDueAt"    el "dueAt" actual.
-- Solo los recalls con algún contacto en su ciclo; el resto queda en 0/NULL,
-- que es lo mismo que un ciclo sin intentos.
--
-- Idempotente: repetirla (`prisma migrate resolve --rolled-back` y `deploy`)
-- recalcula lo mismo desde los mismos contactos (append-only).
DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    WITH cyc AS (
      SELECT rc."recallId", rc."outcome", rc."createdAt", rc."id"
        FROM public."recall_contacts" rc
        JOIN public."patient_recalls" pr
          ON pr."tenantId" = rc."tenantId" AND pr."id" = rc."recallId"
       WHERE rc."tenantId" = t
         AND rc."createdAt" >= pr."lastDoneAt"::timestamp
    ),
    closing AS (
      SELECT DISTINCT ON (c."recallId") c."recallId", c."outcome", c."createdAt", c."id"
        FROM cyc c
       WHERE c."outcome" IN ('BOOKED', 'DECLINED')
       ORDER BY c."recallId", c."createdAt" DESC, c."id" DESC
    ),
    fin AS (
      SELECT k."recallId",
             count(a."id")::int AS "attempts",
             max(a."createdAt") AS "lastAfter",
             cl."outcome" AS "closedBy",
             cl."createdAt" AS "closedAt"
        FROM (SELECT DISTINCT cyc."recallId" FROM cyc) k
        LEFT JOIN closing cl ON cl."recallId" = k."recallId"
        LEFT JOIN cyc a
          ON a."recallId" = k."recallId"
         AND a."outcome" NOT IN ('BOOKED', 'DECLINED')
         AND (cl."id" IS NULL OR (a."createdAt", a."id") > (cl."createdAt", cl."id"))
       GROUP BY k."recallId", cl."outcome", cl."createdAt"
    )
    UPDATE public."patient_recalls" pr SET
      "attemptCount" = fin."attempts",
      "lastAttemptAt" = coalesce(
        fin."lastAfter",
        CASE WHEN fin."closedBy" = 'DECLINED' THEN fin."closedAt" END
      ),
      "callbackOn" = NULL,
      "skipUntil" = CASE
        WHEN fin."closedBy" = 'DECLINED' AND fin."attempts" = 0
          THEN (pr."dueAt" + pg_catalog.make_interval(months => pr."intervalMonths"))::date
      END,
      "cycleDueAt" = pr."dueAt"
      FROM fin
     WHERE pr."tenantId" = t
       AND pr."id" = fin."recallId";
    COMMIT;
  END LOOP;
END
$$;
