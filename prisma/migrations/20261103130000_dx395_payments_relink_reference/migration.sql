-- DX-395: repite el enlace de los abonos con su medio de pago y renormaliza
-- las referencias guardadas.
--
-- 1. Durante el despliegue de DX-377, las réplicas anteriores siguieron
--    cobrando sin "paymentMethodId" (ver la revisión de DX-377). Cada abono
--    con "method" y sin medio se enlaza al medio inicial de ese método en SU
--    clínica: lo mismo que 20261103120100, que es idempotente. Ejecutarla
--    cuando ya no quede ninguna réplica anterior a DX-377.
-- 2. La referencia se compara ahora sin espacios, puntos ni guiones
--    (`normalizeReference`, DX-395): «123-456», «123.456» y «123 456» son la
--    misma. Las ya guardadas tienen "referenceNormalized" sin espacios y en
--    mayúsculas; aquí se le quitan los puntos y los guiones (también los
--    tipográficos U+2010-U+2015 y el signo menos U+2212), la misma limpieza
--    que hace la API. Solo se toca "referenceNormalized": "reference" sigue
--    tal como se tecleó. Una referencia de solo separadores se queda como
--    estaba (el CHECK payments_reference_check exige una normalizada no
--    vacía si hay referencia; la API ya no admite referencias así).
--
-- Una única sentencia (DO): `prisma migrate deploy` la ejecuta fuera de un
-- bloque de transacción, así que cada COMMIT cierra un lote de 2.000 abonos.
-- Ningún lote toma ACCESS EXCLUSIVE: solo los bloqueos de fila de su lote.
-- Recorrido por cursor (tenantId, id > último). Molde de 20261103120100.
--
-- Sin NO FORCE: con un owner sin superusuario ni BYPASSRLS (DX-113) la RLS le
-- aplica, así que recorre las clínicas y fija `app.current_tenant` en cada
-- lote (vuelve a fijarse tras cada COMMIT).
--
-- "updatedAt" de los abonos no cambia. El trigger de saldos del paciente no
-- mira estas columnas. Incluye los abonos anulados (conservan su medio).
--
-- Idempotente: solo escribe abonos con "paymentMethodId" NULL o con algún
-- separador en "referenceNormalized"; una segunda pasada no cambia nada. Si
-- se corta a mitad, basta con repetirla (`prisma migrate resolve
-- --rolled-back 20261103130000_dx395_payments_relink_reference` y `deploy`).
DO $$
DECLARE
  t uuid;
  last_id uuid;
  batch uuid[];
  separators CONSTANT text := '[.‐-―−-]+';
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    last_id := NULL;
    LOOP
      PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
      PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
      SELECT pg_catalog.array_agg(s."id") INTO batch
        FROM (SELECT p."id" FROM public."payments" p
               WHERE p."tenantId" = t
                 AND (last_id IS NULL OR p."id" > last_id)
               ORDER BY p."id"
               LIMIT 2000) s;
      EXIT WHEN batch IS NULL;
      last_id := batch[pg_catalog.array_length(batch, 1)];

      UPDATE public."payments" p
         SET "paymentMethodId" = pm."id"
        FROM public."payment_methods" pm
       WHERE p."tenantId" = t
         AND p."id" = ANY (batch)
         AND p."paymentMethodId" IS NULL
         AND pm."tenantId" = p."tenantId"
         AND pm."legacyMethod" = p."method";

      UPDATE public."payments" p
         SET "referenceNormalized" =
               pg_catalog.regexp_replace(p."referenceNormalized", separators, '', 'g')
       WHERE p."tenantId" = t
         AND p."id" = ANY (batch)
         AND p."referenceNormalized" ~ separators
         AND pg_catalog.regexp_replace(p."referenceNormalized", separators, '', 'g') <> '';
      COMMIT;
    END LOOP;
  END LOOP;
END
$$;
