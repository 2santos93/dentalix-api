-- DX-420: máximo pediátrico, edad mínima y epinefrina por carpule en el
-- catálogo de anestésicos, y su copia en cada registro de anestesia.
-- ADITIVA: columnas nulas; lo ya registrado no cambia (append-only: el
-- trigger de inmutabilidad no salta con ADD COLUMN y no se rellena nada en
-- "anesthesia_administrations"; el cálculo deduce la epinefrina de los
-- registros antiguos del texto del vasoconstrictor).
SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Catálogo
-- ---------------------------------------------------------------------------
ALTER TABLE "anesthetic_products"
  ADD COLUMN "pediatricMaxMgPerKg" DECIMAL(4,2),
  ADD COLUMN "minAgeYears" SMALLINT,
  ADD COLUMN "epinephrineMgPerCarpule" DECIMAL(5,4);

-- Mismos rangos que el DTO (defensa en profundidad ante un INSERT por SQL).
ALTER TABLE "anesthetic_products" ADD CONSTRAINT "anesthetic_products_dx420_range" CHECK (
  ("pediatricMaxMgPerKg" IS NULL OR ("pediatricMaxMgPerKg" > 0 AND "pediatricMaxMgPerKg" <= 20))
  AND ("minAgeYears" IS NULL OR ("minAgeYears" >= 0 AND "minAgeYears" <= 18))
  AND ("epinephrineMgPerCarpule" IS NULL OR ("epinephrineMgPerCarpule" >= 0 AND "epinephrineMgPerCarpule" <= 0.2))
);

-- Valores por defecto REVISABLES por la clínica (AAPD, revisión 2023; ver
-- sample-anesthetics.ts y anesthesia-limits.ts), por principio activo:
--  - lidocaína y mepivacaína: 4,4 mg/kg en menores de 12 años;
--  - articaína: no en menores de 4 años; bupivacaína: no en menores de 12.
UPDATE "anesthetic_products"
SET "pediatricMaxMgPerKg" = 4.4
WHERE "pediatricMaxMgPerKg" IS NULL
  AND "maxMgPerKg" > 4.4
  AND (lower("activeIngredient") LIKE 'lidoca%' OR lower("activeIngredient") LIKE 'mepivaca%');

UPDATE "anesthetic_products"
SET "minAgeYears" = CASE
  WHEN lower("activeIngredient") LIKE 'artica%' THEN 4
  ELSE 12
END
WHERE "minAgeYears" IS NULL
  AND (lower("activeIngredient") LIKE 'artica%' OR lower("activeIngredient") LIKE 'bupivaca%');

-- Epinefrina por carpule = ml × 1000 / dilución (1:100.000 → 0,01 mg/ml),
-- la misma regla que `epinephrineFromLabel`. Sin vasoconstrictor, o con uno
-- que no es epinefrina (felipresina, noradrenalina), 0. Epinefrina sin una
-- dilución legible se queda en NULL: el cálculo avisa de que no la suma.
UPDATE "anesthetic_products"
SET "epinephrineMgPerCarpule" = 0
WHERE "epinephrineMgPerCarpule" IS NULL
  AND ("vasoconstrictor" IS NULL
       OR lower("vasoconstrictor") !~ '(^|[^r])(epinef|adrenal)');

UPDATE "anesthetic_products" p
SET "epinephrineMgPerCarpule" = round(p."mlPerCarpule" * 1000 / d.dilution, 4)
FROM (
  SELECT "id",
         replace(replace(substring(lower("vasoconstrictor")
           FROM '1\s*:\s*(\d{1,3}(?:[.\s]\d{3})+|\d+)'), '.', ''), ' ', '')::numeric AS dilution
  FROM "anesthetic_products"
  WHERE "epinephrineMgPerCarpule" IS NULL
    AND lower("vasoconstrictor") ~ '(^|[^r])(epinef|adrenal)'
) d
WHERE p."id" = d."id"
  AND d.dilution > 0
  AND p."mlPerCarpule" * 1000 / d.dilution <= 0.2;

-- ---------------------------------------------------------------------------
-- 2. Copia en cada registro (append-only; null en los anteriores)
-- ---------------------------------------------------------------------------
ALTER TABLE "anesthesia_administrations"
  ADD COLUMN "pediatricMaxMgPerKg" DECIMAL(4,2),
  ADD COLUMN "minAgeYears" SMALLINT,
  ADD COLUMN "epinephrineMgPerCarpule" DECIMAL(5,4),
  ADD COLUMN "epinephrineMg" DECIMAL(6,4),
  ADD COLUMN "cumulativeEpinephrineMg" DECIMAL(6,4);

ALTER TABLE "anesthesia_administrations" ADD CONSTRAINT "anesthesia_administrations_dx420_range" CHECK (
  ("pediatricMaxMgPerKg" IS NULL OR ("pediatricMaxMgPerKg" > 0 AND "pediatricMaxMgPerKg" <= 20))
  AND ("minAgeYears" IS NULL OR ("minAgeYears" >= 0 AND "minAgeYears" <= 18))
  AND ("epinephrineMgPerCarpule" IS NULL OR "epinephrineMgPerCarpule" >= 0)
  AND ("epinephrineMg" IS NULL OR "epinephrineMg" >= 0)
  AND ("cumulativeEpinephrineMg" IS NULL OR "cumulativeEpinephrineMg" >= 0)
);
