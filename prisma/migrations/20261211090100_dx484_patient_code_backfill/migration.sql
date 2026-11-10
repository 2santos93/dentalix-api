-- DX-484: relleno de patients."patientCode" por clínica y por lotes, sin DDL
-- (DB-029, DB-048).
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra un lote de 2.000
-- pacientes. Ningún lote toma ACCESS EXCLUSIVE: solo la fila del contador de
-- su clínica y los bloqueos de fila de sus pacientes, y solo hasta su COMMIT.
-- Las altas nuevas ya llegan con código (trigger de 20261211090000).
--
-- Orden: dentro de cada clínica, por alta ("createdAt", id), archivados
-- incluidos (un código no se reutiliza). La lista de pendientes se lee una vez
-- por clínica y se recorre por tramos (lineal, sin ORDER BY … LIMIT sobre lo
-- pendiente, DB-048). Cada lote reserva sus números en el MISMO contador que
-- usa el trigger (UPSERT: «último + pendientes del lote») antes de escribirlos,
-- así que un alta que entre a mitad del relleno nunca recibe un número que el
-- relleno vaya a dar. En el despliegue normal no entra ninguna y la clínica
-- queda numerada 1…n por orden de alta; si entra alguna, su código es el
-- siguiente libre y los pendientes siguen después: únicos y estables igual.
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS
-- le aplica, así que fija `app.current_tenant` en cada lote (vuelve a fijarse
-- tras cada COMMIT: set_config(..., true) dura lo que la transacción). Con un
-- owner superusuario el resultado es el mismo.
--
-- El UPDATE dispara patients_code_immutable (0 → número: permitido) y
-- patient_ledgers_patients_update, que solo actúa si cambia "deletedAt": aquí
-- no hace nada. El índice único todavía no existe, así que no se mantiene.
--
-- Idempotente: solo toca filas con código 0. Si se corta a mitad (los lotes
-- hechos quedan, con su contador), basta con repetirla
-- (`prisma migrate resolve --rolled-back` y `deploy`).
DO $$
DECLARE
  t uuid;
  ids uuid[];
  slice uuid[];
  pending uuid[];
  n int;
  total int;
  base int;
  i int;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
    PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
    SELECT pg_catalog.array_agg(p."id" ORDER BY p."createdAt", p."id") INTO ids
      FROM public."patients" p
     WHERE p."tenantId" = t AND p."patientCode" = 0;
    CONTINUE WHEN ids IS NULL;
    total := pg_catalog.array_length(ids, 1);
    i := 1;
    WHILE i <= total LOOP
      PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
      PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
      slice := ids[i : i + 1999];
      -- Los del tramo que siguen pendientes, en su orden.
      SELECT pg_catalog.array_agg(u."id" ORDER BY u."ord") INTO pending
        FROM unnest(slice) WITH ORDINALITY AS u("id", "ord")
        JOIN public."patients" q
          ON q."tenantId" = t AND q."id" = u."id" AND q."patientCode" = 0;
      IF pending IS NOT NULL THEN
        n := pg_catalog.array_length(pending, 1);
        -- Reserva n números en el contador de la clínica (fila bloqueada
        -- hasta el COMMIT: el trigger de alta espera).
        INSERT INTO public."patient_code_counters" AS c ("tenantId", "lastNumber")
        VALUES (t, n)
        ON CONFLICT ("tenantId") DO UPDATE SET "lastNumber" = c."lastNumber" + n
        RETURNING c."lastNumber" - n INTO base;
        UPDATE public."patients" p
           SET "patientCode" = base + s."ord"::int
          FROM unnest(pending) WITH ORDINALITY AS s("id", "ord")
         WHERE p."tenantId" = t
           AND p."id" = s."id"
           AND p."patientCode" = 0;
      END IF;
      COMMIT;
      i := i + 2000;
    END LOOP;
  END LOOP;
END
$$;
