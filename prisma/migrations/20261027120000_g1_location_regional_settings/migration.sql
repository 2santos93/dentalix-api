-- GLOBAL-G1 fase 1 (DX-311 «Producto global, sin supuestos de país»; DX-313,
-- DX-314 y la parte de datos de DX-315): cada sede tiene su moneda ISO 4217,
-- su zona IANA y su locale BCP 47.
--
-- Despliegue sin parada en dos fases (expand/contract, decisión del dueño
-- 2026-10-27; spec GLOBAL-G1 §2.0 y §2.3 bis). Esta es la FASE 1: se aplica
-- con las réplicas antiguas sirviendo, así que solo añade columnas NULL,
-- rellena y añade restricciones que admiten NULL:
--   - una réplica antigua que crea una sede sin nombrar las columnas nuevas
--     sigue funcionando (quedan NULL y `country` toma su default CO, como
--     siempre); el barrido `location-regional-backfill` las rellena con la
--     misma función de abajo;
--   - `locations.country` conserva su default y `location_schedules.timezone`
--     sigue existiendo con el suyo (la leen las réplicas antiguas; el código
--     nuevo la mantiene igual a `locations."timeZone"`).
-- Fase 2 (ticket aparte, spec §11): SET NOT NULL, quitar el default de
-- `country`, borrar `location_schedules.timezone` y esta función.
--
-- Pasos:
--   1. Lista ISO 4217 vigente en `currencies` (generada UNA vez por
--      prisma/scripts/generate-iso4217-sql.ts; la misma que
--      prisma/reference/iso4217.ts). ON CONFLICT DO NOTHING: las 10 monedas
--      ya sembradas conservan su nombre y su símbolo.
--   2. Columnas nuevas en `locations`, todas NULL y sin default.
--   3. Función `dx_g1_backfill_location_regional(p_tenant)`: el ÚNICO sitio
--      con la correspondencia país → valor (D5, R2). Rellena solo columnas
--      NULL (idempotente, nunca pisa un valor elegido) y no toca
--      "regionalSettingsReviewedAt" (queda NULL = «por revisar», aviso D5):
--
--        país | moneda | zona            | locale
--        CO   | COP    | America/Bogota  | es-CO
--        ES   | EUR    | Europe/Madrid   | es-ES
--
--      La zona es la EFECTIVA hoy: la del horario vivo de la sede si
--      Postgres la conoce (pg_timezone_names); si no, la del país (igual que
--      20261017113000_payments_civil_day_noon). Así una sede cuyo ADMIN ya
--      había puesto otra zona en el horario conserva la suya.
--   4. Backfill y comprobación: si queda alguna sede con NULL (un país sin
--      fila en D5), la migración falla en vez de inventar.
--   5. FK a `currencies` y CHECK de longitud, que admiten NULL.
--   6. `treatment_plans.currency` sin default: la API antigua calcula
--      `input.currency ?? 'USD'` antes del INSERT y nunca depende del default.
--   7. `pending_registrations`: país, moneda, zona y locale de la primera
--      sede, NULL en los pendientes de una réplica o una web antiguas.
--
-- row_security = off y NO FORCE durante el backfill y la FK (DX-113/DX-134):
-- en producción el owner no es superusuario ni BYPASSRLS; con FORCE vería 0
-- sedes y el backfill (y su comprobación) no harían nada en silencio. FORCE
-- se restaura en esta misma transacción, después de la FK y los CHECK.
-- lock_timeout: si una transacción larga retiene `locations`, falla limpia y
-- se reintenta el deploy.
--
-- Grants: la función es SECURITY INVOKER y solo la ejecutan el owner (esta
-- migración) y `dentalix_app` (barrido por clínica bajo `runWithTenant` y el
-- `verify` de un registro legado), con la RLS de quien llama.

SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';

-- 1. Monedas ISO 4217: vigentes, sin fondos ni metales (X** salvo XAF, XOF,
-- XPF, XCD y XCG), sin las de 3 decimales (BHD, IQD, JOD, KWD, LYD, OMR, TND:
-- no caben en Decimal(14,2)) y sin códigos retirados (ANG, BGN, CUC, HRK,
-- SLL, ZWL).
INSERT INTO "currencies" ("code", "name", "symbol") VALUES
  ('AED', 'Dírham de los Emiratos Árabes Unidos', 'AED'),
  ('AFN', 'Afgani afgano', '؋'),
  ('ALL', 'Lek albanés', 'ALL'),
  ('AMD', 'Dram armenio', '֏'),
  ('AOA', 'Kuanza angoleño', 'Kz'),
  ('ARS', 'Peso argentino', '$'),
  ('AUD', 'Dólar australiano', '$'),
  ('AWG', 'Florín arubeño', 'AWG'),
  ('AZN', 'Manat azerbaiyano', '₼'),
  ('BAM', 'Marco convertible de Bosnia y Herzegovina', 'KM'),
  ('BBD', 'Dólar barbadense', '$'),
  ('BDT', 'Taka bangladesí', '৳'),
  ('BIF', 'Franco burundés', 'BIF'),
  ('BMD', 'Dólar bermudeño', '$'),
  ('BND', 'Dólar bruneano', '$'),
  ('BOB', 'Boliviano', 'Bs'),
  ('BRL', 'Real brasileño', 'R$'),
  ('BSD', 'Dólar bahameño', '$'),
  ('BTN', 'Gultrum butanés', 'BTN'),
  ('BWP', 'Pula botsuano', 'P'),
  ('BYN', 'Rublo bielorruso', 'р.'),
  ('BZD', 'Dólar beliceño', '$'),
  ('CAD', 'Dólar canadiense', '$'),
  ('CDF', 'Franco congoleño', 'CDF'),
  ('CHF', 'Franco suizo', 'CHF'),
  ('CLP', 'Peso chileno', '$'),
  ('CNY', 'Yuan renminbi', '¥'),
  ('COP', 'Peso colombiano', '$'),
  ('CRC', 'Colón costarricense', '₡'),
  ('CUP', 'Peso cubano', '$'),
  ('CVE', 'Escudo de Cabo Verde', 'CVE'),
  ('CZK', 'Corona checa', 'Kč'),
  ('DJF', 'Franco yibutiano', 'DJF'),
  ('DKK', 'Corona danesa', 'kr'),
  ('DOP', 'Peso dominicano', '$'),
  ('DZD', 'Dinar argelino', 'DZD'),
  ('EGP', 'Libra egipcia', 'EGP'),
  ('ERN', 'Nakfa eritreo', 'ERN'),
  ('ETB', 'Bir etíope', 'ETB'),
  ('EUR', 'Euro', '€'),
  ('FJD', 'Dólar fiyiano', '$'),
  ('FKP', 'Libra malvinense', '£'),
  ('GBP', 'Libra esterlina', '£'),
  ('GEL', 'Lari georgiano', '₾'),
  ('GHS', 'Cedi ghanés', 'GH₵'),
  ('GIP', 'Libra gibraltareña', '£'),
  ('GMD', 'Dalasi gambiano', 'GMD'),
  ('GNF', 'Franco guineano', 'FG'),
  ('GTQ', 'Quetzal guatemalteco', 'Q'),
  ('GYD', 'Dólar guyanés', '$'),
  ('HKD', 'Dólar hongkonés', '$'),
  ('HNL', 'Lempira hondureño', 'L'),
  ('HTG', 'Gurde haitiano', 'HTG'),
  ('HUF', 'Forinto húngaro', 'Ft'),
  ('IDR', 'Rupia indonesia', 'Rp'),
  ('ILS', 'Nuevo séquel israelí', '₪'),
  ('INR', 'Rupia india', '₹'),
  ('IRR', 'Rial iraní', 'IRR'),
  ('ISK', 'Corona islandesa', 'kr'),
  ('JMD', 'Dólar jamaicano', '$'),
  ('JPY', 'Yen japonés', '¥'),
  ('KES', 'Chelín keniano', 'KES'),
  ('KGS', 'Som kirguís', '⃀'),
  ('KHR', 'Riel camboyano', '៛'),
  ('KMF', 'Franco comorense', 'CF'),
  ('KPW', 'Won norcoreano', '₩'),
  ('KRW', 'Won surcoreano', '₩'),
  ('KYD', 'Dólar de las Islas Caimán', '$'),
  ('KZT', 'Tengue kazajo', '₸'),
  ('LAK', 'Kip laosiano', '₭'),
  ('LBP', 'Libra libanesa', 'L£'),
  ('LKR', 'Rupia esrilanquesa', 'Rs'),
  ('LRD', 'Dólar liberiano', '$'),
  ('LSL', 'Loti lesotense', 'LSL'),
  ('MAD', 'Dírham marroquí', 'MAD'),
  ('MDL', 'Leu moldavo', 'MDL'),
  ('MGA', 'Ariari malgache', 'Ar'),
  ('MKD', 'Dinar macedonio', 'MKD'),
  ('MMK', 'Kiat de Myanmar', 'K'),
  ('MNT', 'Tugrik mongol', '₮'),
  ('MOP', 'Pataca macaense', 'MOP'),
  ('MRU', 'Uguiya mauritano', 'MRU'),
  ('MUR', 'Rupia mauriciana', 'Rs'),
  ('MVR', 'Rufiya maldiva', 'MVR'),
  ('MWK', 'Kuacha malauí', 'MWK'),
  ('MXN', 'Peso mexicano', '$'),
  ('MYR', 'Ringit malasio', 'RM'),
  ('MZN', 'Metical mozambiqueño', 'MZN'),
  ('NAD', 'Dólar namibio', '$'),
  ('NGN', 'Naira nigeriano', '₦'),
  ('NIO', 'Córdoba oro', 'C$'),
  ('NOK', 'Corona noruega', 'kr'),
  ('NPR', 'Rupia nepalí', 'Rs'),
  ('NZD', 'Dólar neozelandés', '$'),
  ('PAB', 'Balboa panameño', 'PAB'),
  ('PEN', 'Sol peruano', 'S/'),
  ('PGK', 'Kina papú', 'PGK'),
  ('PHP', 'Peso filipino', '₱'),
  ('PKR', 'Rupia pakistaní', 'Rs'),
  ('PLN', 'Esloti polaco', 'zł'),
  ('PYG', 'Guaraní paraguayo', '₲'),
  ('QAR', 'Rial catarí', 'QAR'),
  ('RON', 'Leu rumano', 'L'),
  ('RSD', 'Dinar serbio', 'RSD'),
  ('RUB', 'Rublo ruso', '₽'),
  ('RWF', 'Franco ruandés', 'RF'),
  ('SAR', 'Rial saudí', 'SAR'),
  ('SBD', 'Dólar salomonense', '$'),
  ('SCR', 'Rupia seychellense', 'SCR'),
  ('SDG', 'Libra sudanesa', 'SDG'),
  ('SEK', 'Corona sueca', 'kr'),
  ('SGD', 'Dólar singapurense', '$'),
  ('SHP', 'Libra de Santa Elena', '£'),
  ('SLE', 'Leona sierraleonesa', 'SLE'),
  ('SOS', 'Chelín somalí', 'SOS'),
  ('SRD', 'Dólar surinamés', '$'),
  ('SSP', 'Libra sursudanesa', '£'),
  ('STN', 'Dobra santotomense', 'Db'),
  ('SVC', 'Colón salvadoreño', 'SVC'),
  ('SYP', 'Libra siria', '£'),
  ('SZL', 'Lilangeni esuatiní', 'SZL'),
  ('THB', 'Bat tailandés', '฿'),
  ('TJS', 'Somoni tayiko', 'TJS'),
  ('TMT', 'Manat turcomano', 'TMT'),
  ('TOP', 'Paanga tongano', 'T$'),
  ('TRY', 'Lira turca', '₺'),
  ('TTD', 'Dólar de Trinidad y Tobago', '$'),
  ('TWD', 'Nuevo dólar taiwanés', 'NT$'),
  ('TZS', 'Chelín tanzano', 'TZS'),
  ('UAH', 'Grivna ucraniana', '₴'),
  ('UGX', 'Chelín ugandés', 'UGX'),
  ('USD', 'Dólar estadounidense', '$'),
  ('UYU', 'Peso uruguayo', '$'),
  ('UZS', 'Sum uzbeko', 'UZS'),
  ('VES', 'Bolívar venezolano', 'VES'),
  ('VND', 'Dong vietnamita', '₫'),
  ('VUV', 'Vatu vanuatense', 'VUV'),
  ('WST', 'Tala samoano', 'WST'),
  ('XAF', 'Franco CFA de África Central', 'XAF'),
  ('XCD', 'Dólar del Caribe Oriental', '$'),
  ('XCG', 'Florín caribeño', 'Cg.'),
  ('XOF', 'Franco CFA de África Occidental', 'XOF'),
  ('XPF', 'Franco CFP', 'CFPF'),
  ('YER', 'Rial yemení', 'YER'),
  ('ZAR', 'Rand sudafricano', 'R'),
  ('ZMW', 'Kuacha zambiano', 'ZK'),
  ('ZWG', 'Oro de Zimbabue', 'ZWG')
ON CONFLICT ("code") DO NOTHING;

-- 2. Columnas de la sede (NULL, sin default: un INSERT antiguo sigue valiendo).
ALTER TABLE "locations"
  ADD COLUMN "currency" CHAR(3),
  ADD COLUMN "timeZone" TEXT,
  ADD COLUMN "locale" TEXT,
  ADD COLUMN "regionalSettingsReviewedAt" TIMESTAMPTZ(3);

-- 3. Backfill D5 (spec §2.2.3, R3, R19). Con p_tenant solo barre esa clínica.
CREATE OR REPLACE FUNCTION public.dx_g1_backfill_location_regional(p_tenant uuid DEFAULT NULL)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  updated integer;
BEGIN
  UPDATE public."locations" AS l
     SET "currency" = COALESCE(l."currency",
           CASE l."country" WHEN 'CO' THEN 'COP' WHEN 'ES' THEN 'EUR' END),
         "timeZone" = COALESCE(l."timeZone",
           (SELECT s."timezone"
              FROM public."location_schedules" AS s
             WHERE s."tenantId" = l."tenantId"
               AND s."locationId" = l."id"
               AND s."deletedAt" IS NULL
               AND s."timezone" IN (SELECT z."name" FROM pg_catalog.pg_timezone_names AS z)
             LIMIT 1),
           CASE l."country" WHEN 'CO' THEN 'America/Bogota' WHEN 'ES' THEN 'Europe/Madrid' END),
         "locale" = COALESCE(l."locale",
           CASE l."country" WHEN 'CO' THEN 'es-CO' WHEN 'ES' THEN 'es-ES' END)
   WHERE (l."currency" IS NULL OR l."timeZone" IS NULL OR l."locale" IS NULL)
     AND (p_tenant IS NULL OR l."tenantId" = p_tenant);
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END;
$$;

REVOKE ALL ON FUNCTION public.dx_g1_backfill_location_regional(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION public.dx_g1_backfill_location_regional(uuid) TO dentalix_app;
  END IF;
END
$$;

-- 4. Backfill de todas las sedes (también las retiradas) y comprobación.
ALTER TABLE "locations" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "location_schedules" NO FORCE ROW LEVEL SECURITY;

SELECT public.dx_g1_backfill_location_regional();

DO $$
DECLARE
  missing bigint;
BEGIN
  SELECT count(*) INTO missing
    FROM "locations"
   WHERE "currency" IS NULL OR "timeZone" IS NULL OR "locale" IS NULL;
  IF missing > 0 THEN
    RAISE EXCEPTION 'GLOBAL-G1: % sede(s) sin moneda, zona o locale tras el backfill D5 (país sin correspondencia); no se inventa un valor', missing;
  END IF;
END
$$;

-- 5. Restricciones que admiten NULL (fase 1). La FK valida las filas con
-- FORCE fuera (DX-274).
ALTER TABLE "locations"
  ADD CONSTRAINT "locations_currency_fkey" FOREIGN KEY ("currency")
    REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "locations_locale_length_check"
    CHECK ("locale" IS NULL OR char_length("locale") BETWEEN 2 AND 35),
  ADD CONSTRAINT "locations_time_zone_length_check"
    CHECK ("timeZone" IS NULL OR char_length("timeZone") BETWEEN 1 AND 64);

ALTER TABLE "location_schedules" FORCE ROW LEVEL SECURITY;
ALTER TABLE "locations" FORCE ROW LEVEL SECURITY;

-- 6. Planes: la moneda la escribe siempre quien crea el plan.
ALTER TABLE "treatment_plans" ALTER COLUMN "currency" DROP DEFAULT;

-- 7. Primera sede del registro (NULL = pendiente legado).
ALTER TABLE "pending_registrations"
  ADD COLUMN "locationCountry" "ClinicCountry",
  ADD COLUMN "locationCurrency" CHAR(3),
  ADD COLUMN "locationTimeZone" TEXT,
  ADD COLUMN "locationLocale" TEXT;
