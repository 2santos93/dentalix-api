-- DX-467: código de verificación para las recetas emitidas antes (3 de 5).
--
-- Decisión: barrido en la migración, no perezoso. Así toda receta (también
-- las emitidas antes de DX-467) tiene su código desde el despliegue, la
-- columna pasa a NOT NULL en 20261126090300 y la API nunca escribe en una
-- receta emitida al leerla (la receta sigue siendo inmutable para la app).
-- Una receta impresa antes de DX-467 no lleva el código en el papel; al
-- reimprimirla, sí.
--
-- Una única sentencia (DO), que `prisma migrate deploy` ejecuta fuera de un
-- bloque de transacción: cada COMMIT cierra un lote de 500 recetas (molde de
-- 20261116090100_dx472bis_ledgers_converted_backfill). Solo bloqueos de fila
-- de cada lote hasta su COMMIT; nada de ACCESS EXCLUSIVE. Sin NO FORCE: con un
-- owner sin superusuario ni BYPASSRLS la RLS le aplica, así que recorre las
-- clínicas (también las retiradas: sus recetas siguen siendo documentos) y
-- fija `app.current_tenant` en cada lote. El trigger prescriptions_immutable
-- admite exactamente este cambio (NULL → código, nada más) desde
-- 20261126090000.
--
-- Colisión con un código de la misma clínica (índice único de
-- 20261126090100): se reintenta esa receta con otro código, en su propio
-- subbloque. Idempotente: solo toca las que siguen sin código. Si se corta,
-- `prisma migrate resolve --rolled-back
-- 20261126090200_dx467_prescription_verification_code_backfill` y `deploy`.
DO $$
DECLARE
  t uuid;
  batch uuid[];
  rx uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    LOOP
      PERFORM pg_catalog.set_config('app.current_tenant', t::text, true);
      PERFORM pg_catalog.set_config('lock_timeout', '5s', true);
      SELECT pg_catalog.array_agg(s."id") INTO batch
        FROM (SELECT p."id" FROM public."prescriptions" p
               WHERE p."tenantId" = t AND p."verificationCode" IS NULL
               ORDER BY p."id"
               LIMIT 500) s;
      EXIT WHEN batch IS NULL;
      FOREACH rx IN ARRAY batch LOOP
        LOOP
          BEGIN
            UPDATE public."prescriptions"
               SET "verificationCode" = public."prescription_verification_code"()
             WHERE "tenantId" = t AND "id" = rx AND "verificationCode" IS NULL;
            EXIT;
          EXCEPTION WHEN unique_violation THEN
            -- Mismo código que otra receta de la clínica: se sortea otro.
          END;
        END LOOP;
      END LOOP;
      COMMIT;
    END LOOP;
  END LOOP;
END
$$;
