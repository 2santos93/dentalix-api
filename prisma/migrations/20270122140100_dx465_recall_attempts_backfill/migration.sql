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
--   "skipUntil"     si el último es un «Rechaza»: el vencimiento de la serie
--                   siguiente a su día (dx_recall_next_due_after, como la app);
--   "callbackOn"    el que ya tuviera la fila si el último contacto del ciclo
--                   es un «Llamar luego» (repetir el relleno no pisa uno que
--                   ya escribió la API nueva); si no, NULL: los anteriores no
--                   tenían fecha y ocultan los días de la sede;
--   "cycleDueAt"    el "dueAt" actual.
-- Solo los recalls con algún contacto en su ciclo; el resto queda en 0/NULL,
-- que es lo mismo que un ciclo sin intentos. No marca el teléfono de los
-- «Número equivocado» antiguos (revisión DX-465, ruling 10): la marca nace
-- con los intentos nuevos.
--
-- Ventana de despliegue (aceptada): lo que la API anterior registre entre el
-- relleno de una clínica y el cambio de API no cuenta en el ciclo (ni suma
-- ni oculta); repetir el relleno después lo recoge sin perder fechas.
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
    latest AS (
      SELECT DISTINCT ON (c."recallId") c."recallId", c."outcome"
        FROM cyc c
       ORDER BY c."recallId", c."createdAt" DESC, c."id" DESC
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
             cl."createdAt" AS "closedAt",
             la."outcome" AS "lastOutcome"
        FROM (SELECT DISTINCT cyc."recallId" FROM cyc) k
        JOIN latest la ON la."recallId" = k."recallId"
        LEFT JOIN closing cl ON cl."recallId" = k."recallId"
        LEFT JOIN cyc a
          ON a."recallId" = k."recallId"
         AND a."outcome" NOT IN ('BOOKED', 'DECLINED')
         AND (cl."id" IS NULL OR (a."createdAt", a."id") > (cl."createdAt", cl."id"))
       GROUP BY k."recallId", cl."outcome", cl."createdAt", la."outcome"
    )
    UPDATE public."patient_recalls" pr SET
      "attemptCount" = fin."attempts",
      "lastAttemptAt" = coalesce(
        fin."lastAfter",
        CASE WHEN fin."closedBy" = 'DECLINED' THEN fin."closedAt" END
      ),
      "callbackOn" = CASE WHEN fin."lastOutcome" = 'CALL_BACK' THEN pr."callbackOn" END,
      "skipUntil" = CASE
        WHEN fin."closedBy" = 'DECLINED' AND fin."attempts" = 0
          THEN public.dx_recall_next_due_after(
                 pr."dueAt", pr."intervalMonths", (fin."closedAt")::date)
      END,
      "cycleDueAt" = pr."dueAt"
      FROM fin
     WHERE pr."tenantId" = t
       AND pr."id" = fin."recallId";
    COMMIT;
  END LOOP;
END
$$;
