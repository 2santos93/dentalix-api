-- DX-042 (DB-016): FK de "currency" al catalogo de monedas.
--
-- payments.currency, treatment_plans.currency y payment_plans.currency solo se
-- validaban contra `currencies` en la app (CurrencyWhitelist). Un script o un
-- seed podia escribir un codigo bien formado pero inexistente ("ZZZ"; el
-- formato ya lo cubre el CHECK *_currency_format de 20261016130000). Ahora la
-- base exige que el codigo exista en `currencies`.
--
-- Seguro: `currencies` se siembra en una migracion (20260727130000_seed_
-- currencies) y nada la borra; la app solo escribe codigos de la whitelist.
-- ON DELETE RESTRICT / ON UPDATE CASCADE: el default de Prisma para una
-- relacion obligatoria (lo que declara schema.prisma), igual que las demas FK.
--
-- FK de "tenantId" a tenants(id) (la otra mitad de DB-016): NO se anade aqui a
-- proposito. Toda suite e2e limpia con `tenant.deleteMany()` global dejando
-- detras sedes, catalogo y horarios que crea el registro; con una FK RESTRICT
-- esas limpiezas (y las de cualquier rama en curso que siga el patron)
-- fallarian. Queda documentado como pendiente en el informe de DX-042; la RLS
-- sigue impidiendo LEER filas huerfanas.
--
-- Mismo esquema de seguridad que 20261016130000_domain_checks: row_security
-- off, locks SHARE ROW EXCLUSIVE en orden fijo y pre-flight con desglose.

SET LOCAL row_security = off;

-- ADD FOREIGN KEY toma SHARE ROW EXCLUSIVE en las dos tablas: el lock de abajo
-- es el mismo, asi que no escala. lock_timeout: ver 20261016130000_domain_checks.
SET LOCAL lock_timeout = '10s';
LOCK TABLE "currencies", "treatment_plans", "payments", "payment_plans"
  IN SHARE ROW EXCLUSIVE MODE;

DO $$
DECLARE
  bad text := '';
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "treatment_plans" t
   WHERE NOT EXISTS (SELECT 1 FROM "currencies" c WHERE c."code" = t."currency");
  IF n > 0 THEN bad := bad || format(E'\n  treatment_plans.currency: %s', n); END IF;

  SELECT count(*) INTO n FROM "payments" t
   WHERE NOT EXISTS (SELECT 1 FROM "currencies" c WHERE c."code" = t."currency");
  IF n > 0 THEN bad := bad || format(E'\n  payments.currency: %s', n); END IF;

  SELECT count(*) INTO n FROM "payment_plans" t
   WHERE NOT EXISTS (SELECT 1 FROM "currencies" c WHERE c."code" = t."currency");
  IF n > 0 THEN bad := bad || format(E'\n  payment_plans.currency: %s', n); END IF;

  IF bad <> '' THEN
    RAISE EXCEPTION 'DX-042: hay filas con una moneda que no esta en el catalogo `currencies`. No se crea ninguna FK ni se toca ningun dato. Filas por columna:%', bad
      USING HINT = 'Anade la moneda al catalogo o corrige esas filas a mano, marca la migracion con prisma migrate resolve --rolled-back 20261016131000_currency_fks y vuelve a ejecutar prisma migrate deploy.';
  END IF;
END $$;

ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_currency_fkey"
  FOREIGN KEY ("currency") REFERENCES "currencies"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" ADD CONSTRAINT "payments_currency_fkey"
  FOREIGN KEY ("currency") REFERENCES "currencies"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_currency_fkey"
  FOREIGN KEY ("currency") REFERENCES "currencies"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;
