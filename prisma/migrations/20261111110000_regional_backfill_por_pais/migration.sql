-- Z1 (producto global, sin país): el barrido de fase 1 de GLOBAL-G1
-- (`dx_g1_backfill_location_regional`, job `locations.regional-backfill` y
-- `npm run g1:backfill-locations`) deja de tener una correspondencia escrita
-- a mano para dos países y pasa a derivar moneda, zona y formato del país de
-- la sede con una tabla de TODOS los países de la lista ISO 3166 de la base
-- (`prisma/reference/country-regional-defaults.json`, generada por
-- `prisma/scripts/generate-country-regional-defaults.ts` con las mismas
-- reglas que la propuesta de la web al dar de alta una sede, R1). Ningún país
-- tiene un caso propio.
--
-- Igual que antes:
--   - solo rellena columnas NULL (nunca pisa un valor elegido) y no marca la
--     sede como revisada ("regionalSettingsReviewedAt" sigue NULL: aviso D5);
--   - la zona es la del horario vivo de la sede si Postgres la conoce; si no,
--     la del país;
--   - misma firma, SECURITY INVOKER, mismos grants: el job y el script no
--     cambian.
-- Distinto:
--   - lee el país de "countryCode" (DX-312), no de la columna enum anterior;
--   - un país con varias zonas no propone ninguna (se elige en Ajustes, como
--     en la web); un país sin dato deja esa columna NULL en vez de inventar;
--   - solo cuenta (y escribe) las sedes en las que rellena algo, así una
--     segunda pasada sigue devolviendo 0 aunque quede una columna sin dato.
-- Las sedes anteriores a G1 se rellenaron en 20261027120000 (que falló si
-- quedaba alguna NULL) y desde DX-312 una réplica anterior ya no puede crear
-- una sede sin datos regionales: la función solo actúa sobre una fila puesta
-- a mano con país y sin datos. No toca filas al aplicarse.

CREATE OR REPLACE FUNCTION public.dx_g1_backfill_location_regional(p_tenant uuid DEFAULT NULL)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  updated integer;
BEGIN
  WITH defaults ("country", "currency", "timeZone", "locale") AS (
    VALUES
    ('AD', 'EUR', 'Europe/Andorra', 'ca-AD'),
    ('AE', 'AED', 'Asia/Dubai', 'ar-AE'),
    ('AF', 'AFN', 'Asia/Kabul', 'fa-AF'),
    ('AG', 'XCD', 'America/Antigua', 'en-AG'),
    ('AI', 'XCD', 'America/Anguilla', 'en-AI'),
    ('AL', 'ALL', 'Europe/Tirane', 'sq-AL'),
    ('AM', 'AMD', 'Asia/Yerevan', 'hy-AM'),
    ('AO', 'AOA', 'Africa/Luanda', 'pt-AO'),
    ('AQ', NULL, NULL, 'en-AQ'),
    ('AR', 'ARS', NULL, 'es-AR'),
    ('AS', 'USD', 'Pacific/Pago_Pago', NULL),
    ('AT', 'EUR', 'Europe/Vienna', 'de-AT'),
    ('AU', 'AUD', NULL, 'en-AU'),
    ('AW', 'AWG', 'America/Aruba', 'nl-AW'),
    ('AX', 'EUR', 'Europe/Mariehamn', 'sv-AX'),
    ('AZ', 'AZN', 'Asia/Baku', 'az-AZ'),
    ('BA', 'BAM', 'Europe/Sarajevo', 'bs-BA'),
    ('BB', 'BBD', 'America/Barbados', 'en-BB'),
    ('BD', 'BDT', 'Asia/Dhaka', 'bn-BD'),
    ('BE', 'EUR', 'Europe/Brussels', 'nl-BE'),
    ('BF', 'XOF', 'Africa/Ouagadougou', 'fr-BF'),
    ('BG', 'EUR', 'Europe/Sofia', 'bg-BG'),
    ('BH', NULL, 'Asia/Bahrain', 'ar-BH'),
    ('BI', 'BIF', 'Africa/Bujumbura', 'rn-BI'),
    ('BJ', 'XOF', 'Africa/Porto-Novo', 'fr-BJ'),
    ('BL', 'EUR', 'America/St_Barthelemy', 'fr-BL'),
    ('BM', 'BMD', 'Atlantic/Bermuda', 'en-BM'),
    ('BN', 'BND', 'Asia/Brunei', 'ms-BN'),
    ('BO', 'BOB', 'America/La_Paz', 'es-BO'),
    ('BQ', 'USD', 'America/Kralendijk', NULL),
    ('BR', 'BRL', NULL, 'pt-BR'),
    ('BS', 'BSD', 'America/Nassau', 'en-BS'),
    ('BT', 'BTN', 'Asia/Thimphu', 'dz-BT'),
    ('BV', 'NOK', NULL, 'no-BV'),
    ('BW', 'BWP', 'Africa/Gaborone', 'en-BW'),
    ('BY', 'BYN', 'Europe/Minsk', 'be-BY'),
    ('BZ', 'BZD', 'America/Belize', 'en-BZ'),
    ('CA', 'CAD', NULL, 'en-CA'),
    ('CC', 'AUD', 'Indian/Cocos', 'ms-CC'),
    ('CD', 'CDF', NULL, 'fr-CD'),
    ('CF', 'XAF', 'Africa/Bangui', 'sg-CF'),
    ('CG', 'XAF', 'Africa/Brazzaville', 'fr-CG'),
    ('CH', 'CHF', 'Europe/Zurich', 'de-CH'),
    ('CI', 'XOF', 'Africa/Abidjan', 'fr-CI'),
    ('CK', 'NZD', 'Pacific/Rarotonga', 'en-CK'),
    ('CL', 'CLP', NULL, 'es-CL'),
    ('CM', 'XAF', 'Africa/Douala', 'fr-CM'),
    ('CN', 'CNY', NULL, 'zh-CN'),
    ('CO', 'COP', 'America/Bogota', 'es-CO'),
    ('CR', 'CRC', 'America/Costa_Rica', 'es-CR'),
    ('CU', 'CUP', 'America/Havana', 'es-CU'),
    ('CV', 'CVE', 'Atlantic/Cape_Verde', 'pt-CV'),
    ('CW', 'XCG', 'America/Curacao', NULL),
    ('CX', 'AUD', 'Indian/Christmas', 'en-CX'),
    ('CY', 'EUR', NULL, 'el-CY'),
    ('CZ', 'CZK', 'Europe/Prague', 'cs-CZ'),
    ('DE', 'EUR', NULL, 'de-DE'),
    ('DJ', 'DJF', 'Africa/Djibouti', 'fr-DJ'),
    ('DK', 'DKK', 'Europe/Copenhagen', 'da-DK'),
    ('DM', 'XCD', 'America/Dominica', 'en-DM'),
    ('DO', 'DOP', 'America/Santo_Domingo', 'es-DO'),
    ('DZ', 'DZD', 'Africa/Algiers', 'ar-DZ'),
    ('EC', 'USD', NULL, 'es-EC'),
    ('EE', 'EUR', 'Europe/Tallinn', 'et-EE'),
    ('EG', 'EGP', 'Africa/Cairo', 'ar-EG'),
    ('EH', 'MAD', 'Africa/El_Aaiun', 'ar-EH'),
    ('ER', 'ERN', 'Africa/Asmara', 'ti-ER'),
    ('ES', 'EUR', NULL, 'es-ES'),
    ('ET', 'ETB', 'Africa/Addis_Ababa', 'am-ET'),
    ('FI', 'EUR', 'Europe/Helsinki', 'fi-FI'),
    ('FJ', 'FJD', 'Pacific/Fiji', 'en-FJ'),
    ('FK', 'FKP', 'Atlantic/Stanley', 'en-FK'),
    ('FM', 'USD', NULL, 'en-FM'),
    ('FO', 'DKK', 'Atlantic/Faroe', 'fo-FO'),
    ('FR', 'EUR', 'Europe/Paris', 'fr-FR'),
    ('GA', 'XAF', 'Africa/Libreville', 'fr-GA'),
    ('GB', 'GBP', 'Europe/London', 'en-GB'),
    ('GD', 'XCD', 'America/Grenada', 'en-GD'),
    ('GE', 'GEL', 'Asia/Tbilisi', 'ka-GE'),
    ('GF', 'EUR', 'America/Cayenne', 'fr-GF'),
    ('GG', 'GBP', 'Europe/Guernsey', 'en-GG'),
    ('GH', 'GHS', 'Africa/Accra', 'ak-GH'),
    ('GI', 'GIP', 'Europe/Gibraltar', 'en-GI'),
    ('GL', 'DKK', NULL, 'kl-GL'),
    ('GM', 'GMD', 'Africa/Banjul', 'en-GM'),
    ('GN', 'GNF', 'Africa/Conakry', 'fr-GN'),
    ('GP', 'EUR', 'America/Guadeloupe', 'fr-GP'),
    ('GQ', 'XAF', 'Africa/Malabo', 'es-GQ'),
    ('GR', 'EUR', 'Europe/Athens', 'el-GR'),
    ('GS', 'GBP', 'Atlantic/South_Georgia', 'en-GS'),
    ('GT', 'GTQ', 'America/Guatemala', 'es-GT'),
    ('GU', 'USD', 'Pacific/Guam', 'en-GU'),
    ('GW', 'XOF', 'Africa/Bissau', 'pt-GW'),
    ('GY', 'GYD', 'America/Guyana', 'en-GY'),
    ('HK', 'HKD', 'Asia/Hong_Kong', 'zh-HK'),
    ('HM', 'AUD', NULL, 'en-HM'),
    ('HN', 'HNL', 'America/Tegucigalpa', 'es-HN'),
    ('HR', 'EUR', 'Europe/Zagreb', 'hr-HR'),
    ('HT', 'HTG', 'America/Port-au-Prince', NULL),
    ('HU', 'HUF', 'Europe/Budapest', 'hu-HU'),
    ('ID', 'IDR', NULL, 'id-ID'),
    ('IE', 'EUR', 'Europe/Dublin', 'en-IE'),
    ('IL', 'ILS', 'Asia/Jerusalem', 'he-IL'),
    ('IM', 'GBP', 'Europe/Isle_of_Man', 'en-IM'),
    ('IN', 'INR', 'Asia/Kolkata', 'hi-IN'),
    ('IO', 'USD', 'Indian/Chagos', 'en-IO'),
    ('IQ', NULL, 'Asia/Baghdad', 'ar-IQ'),
    ('IR', 'IRR', 'Asia/Tehran', 'fa-IR'),
    ('IS', 'ISK', 'Atlantic/Reykjavik', 'is-IS'),
    ('IT', 'EUR', 'Europe/Rome', 'it-IT'),
    ('JE', 'GBP', 'Europe/Jersey', 'en-JE'),
    ('JM', 'JMD', 'America/Jamaica', 'en-JM'),
    ('JO', NULL, 'Asia/Amman', 'ar-JO'),
    ('JP', 'JPY', 'Asia/Tokyo', 'ja-JP'),
    ('KE', 'KES', 'Africa/Nairobi', 'sw-KE'),
    ('KG', 'KGS', 'Asia/Bishkek', 'ky-KG'),
    ('KH', 'KHR', 'Asia/Phnom_Penh', 'km-KH'),
    ('KI', 'AUD', NULL, 'en-KI'),
    ('KM', 'KMF', 'Indian/Comoro', 'ar-KM'),
    ('KN', 'XCD', 'America/St_Kitts', 'en-KN'),
    ('KP', 'KPW', 'Asia/Pyongyang', 'ko-KP'),
    ('KR', 'KRW', 'Asia/Seoul', 'ko-KR'),
    ('KW', NULL, 'Asia/Kuwait', 'ar-KW'),
    ('KY', 'KYD', 'America/Cayman', 'en-KY'),
    ('KZ', 'KZT', NULL, 'ru-KZ'),
    ('LA', 'LAK', 'Asia/Vientiane', 'lo-LA'),
    ('LB', 'LBP', 'Asia/Beirut', 'ar-LB'),
    ('LC', 'XCD', 'America/St_Lucia', 'en-LC'),
    ('LI', 'CHF', 'Europe/Vaduz', 'de-LI'),
    ('LK', 'LKR', 'Asia/Colombo', 'si-LK'),
    ('LR', 'LRD', 'Africa/Monrovia', 'en-LR'),
    ('LS', 'LSL', 'Africa/Maseru', 'st-LS'),
    ('LT', 'EUR', 'Europe/Vilnius', 'lt-LT'),
    ('LU', 'EUR', 'Europe/Luxembourg', 'fr-LU'),
    ('LV', 'EUR', 'Europe/Riga', 'lv-LV'),
    ('LY', NULL, 'Africa/Tripoli', 'ar-LY'),
    ('MA', 'MAD', 'Africa/Casablanca', 'ar-MA'),
    ('MC', 'EUR', 'Europe/Monaco', 'fr-MC'),
    ('MD', 'MDL', 'Europe/Chisinau', 'ro-MD'),
    ('ME', 'EUR', 'Europe/Podgorica', 'sr-ME'),
    ('MF', 'EUR', 'America/Marigot', 'fr-MF'),
    ('MG', 'MGA', 'Indian/Antananarivo', 'mg-MG'),
    ('MH', 'USD', NULL, 'en-MH'),
    ('MK', 'MKD', 'Europe/Skopje', 'mk-MK'),
    ('ML', 'XOF', 'Africa/Bamako', 'bm-ML'),
    ('MM', 'MMK', 'Asia/Yangon', 'my-MM'),
    ('MN', 'MNT', NULL, 'mn-MN'),
    ('MO', 'MOP', 'Asia/Macau', 'zh-MO'),
    ('MP', 'USD', 'Pacific/Saipan', 'en-MP'),
    ('MQ', 'EUR', 'America/Martinique', 'fr-MQ'),
    ('MR', 'MRU', 'Africa/Nouakchott', 'ar-MR'),
    ('MS', 'XCD', 'America/Montserrat', 'en-MS'),
    ('MT', 'EUR', 'Europe/Malta', 'mt-MT'),
    ('MU', 'MUR', 'Indian/Mauritius', 'fr-MU'),
    ('MV', 'MVR', 'Indian/Maldives', NULL),
    ('MW', 'MWK', 'Africa/Blantyre', 'en-MW'),
    ('MX', 'MXN', NULL, 'es-MX'),
    ('MY', 'MYR', NULL, 'ms-MY'),
    ('MZ', 'MZN', 'Africa/Maputo', 'pt-MZ'),
    ('NA', 'NAD', 'Africa/Windhoek', 'af-NA'),
    ('NC', 'XPF', 'Pacific/Noumea', 'fr-NC'),
    ('NE', 'XOF', 'Africa/Niamey', 'ha-NE'),
    ('NF', 'AUD', 'Pacific/Norfolk', 'en-NF'),
    ('NG', 'NGN', 'Africa/Lagos', 'en-NG'),
    ('NI', 'NIO', 'America/Managua', 'es-NI'),
    ('NL', 'EUR', 'Europe/Amsterdam', 'nl-NL'),
    ('NO', 'NOK', 'Europe/Oslo', 'nb-NO'),
    ('NP', 'NPR', 'Asia/Kathmandu', 'ne-NP'),
    ('NR', 'AUD', 'Pacific/Nauru', 'en-NR'),
    ('NU', 'NZD', 'Pacific/Niue', 'en-NU'),
    ('NZ', 'NZD', NULL, 'en-NZ'),
    ('OM', NULL, 'Asia/Muscat', 'ar-OM'),
    ('PA', 'USD', 'America/Panama', 'es-PA'),
    ('PE', 'PEN', 'America/Lima', 'es-PE'),
    ('PF', 'XPF', NULL, 'fr-PF'),
    ('PG', 'PGK', NULL, NULL),
    ('PH', 'PHP', 'Asia/Manila', 'fil-PH'),
    ('PK', 'PKR', 'Asia/Karachi', 'ur-PK'),
    ('PL', 'PLN', 'Europe/Warsaw', 'pl-PL'),
    ('PM', 'EUR', 'America/Miquelon', 'fr-PM'),
    ('PN', 'NZD', 'Pacific/Pitcairn', 'en-PN'),
    ('PR', 'USD', 'America/Puerto_Rico', 'es-PR'),
    ('PS', 'ILS', NULL, 'ar-PS'),
    ('PT', 'EUR', NULL, 'pt-PT'),
    ('PW', 'USD', 'Pacific/Palau', NULL),
    ('PY', 'PYG', 'America/Asuncion', NULL),
    ('QA', 'QAR', 'Asia/Qatar', 'ar-QA'),
    ('RE', 'EUR', 'Indian/Reunion', 'fr-RE'),
    ('RO', 'RON', 'Europe/Bucharest', 'ro-RO'),
    ('RS', 'RSD', 'Europe/Belgrade', 'sr-RS'),
    ('RU', 'RUB', NULL, 'ru-RU'),
    ('RW', 'RWF', 'Africa/Kigali', 'rw-RW'),
    ('SA', 'SAR', 'Asia/Riyadh', 'ar-SA'),
    ('SB', 'SBD', 'Pacific/Guadalcanal', 'en-SB'),
    ('SC', 'SCR', 'Indian/Mahe', 'fr-SC'),
    ('SD', 'SDG', 'Africa/Khartoum', 'ar-SD'),
    ('SE', 'SEK', 'Europe/Stockholm', 'sv-SE'),
    ('SG', 'SGD', 'Asia/Singapore', 'en-SG'),
    ('SH', 'SHP', 'Atlantic/St_Helena', 'en-SH'),
    ('SI', 'EUR', 'Europe/Ljubljana', 'sl-SI'),
    ('SJ', 'NOK', 'Arctic/Longyearbyen', 'nb-SJ'),
    ('SK', 'EUR', 'Europe/Bratislava', 'sk-SK'),
    ('SL', 'SLE', 'Africa/Freetown', 'en-SL'),
    ('SM', 'EUR', 'Europe/San_Marino', 'it-SM'),
    ('SN', 'XOF', 'Africa/Dakar', 'wo-SN'),
    ('SO', 'SOS', 'Africa/Mogadishu', 'so-SO'),
    ('SR', 'SRD', 'America/Paramaribo', 'nl-SR'),
    ('SS', 'SSP', 'Africa/Juba', 'ar-SS'),
    ('ST', 'STN', 'Africa/Sao_Tome', 'pt-ST'),
    ('SV', 'USD', 'America/El_Salvador', 'es-SV'),
    ('SX', 'XCG', 'America/Lower_Princes', 'en-SX'),
    ('SY', 'SYP', 'Asia/Damascus', 'ar-SY'),
    ('SZ', 'SZL', 'Africa/Mbabane', 'en-SZ'),
    ('TC', 'USD', 'America/Grand_Turk', 'en-TC'),
    ('TD', 'XAF', 'Africa/Ndjamena', 'ar-TD'),
    ('TF', 'EUR', 'Indian/Kerguelen', 'fr-TF'),
    ('TG', 'XOF', 'Africa/Lome', 'fr-TG'),
    ('TH', 'THB', 'Asia/Bangkok', 'th-TH'),
    ('TJ', 'TJS', 'Asia/Dushanbe', 'tg-TJ'),
    ('TK', 'NZD', 'Pacific/Fakaofo', NULL),
    ('TL', 'USD', 'Asia/Dili', 'pt-TL'),
    ('TM', 'TMT', 'Asia/Ashgabat', 'tk-TM'),
    ('TN', NULL, 'Africa/Tunis', 'ar-TN'),
    ('TO', 'TOP', 'Pacific/Tongatapu', 'to-TO'),
    ('TR', 'TRY', 'Europe/Istanbul', 'tr-TR'),
    ('TT', 'TTD', 'America/Port_of_Spain', 'en-TT'),
    ('TV', 'AUD', 'Pacific/Funafuti', NULL),
    ('TW', 'TWD', 'Asia/Taipei', 'zh-TW'),
    ('TZ', 'TZS', 'Africa/Dar_es_Salaam', 'sw-TZ'),
    ('UA', 'UAH', NULL, 'uk-UA'),
    ('UG', 'UGX', 'Africa/Kampala', 'sw-UG'),
    ('UM', 'USD', NULL, 'en-UM'),
    ('US', 'USD', NULL, 'en-US'),
    ('UY', 'UYU', 'America/Montevideo', 'es-UY'),
    ('UZ', 'UZS', NULL, 'uz-UZ'),
    ('VA', 'EUR', 'Europe/Vatican', 'it-VA'),
    ('VC', 'XCD', 'America/St_Vincent', 'en-VC'),
    ('VE', 'USD', 'America/Caracas', 'es-VE'),
    ('VG', 'USD', 'America/Tortola', 'en-VG'),
    ('VI', 'USD', 'America/St_Thomas', 'en-VI'),
    ('VN', 'VND', 'Asia/Ho_Chi_Minh', 'vi-VN'),
    ('VU', 'VUV', 'Pacific/Efate', NULL),
    ('WF', 'XPF', 'Pacific/Wallis', 'fr-WF'),
    ('WS', 'WST', 'Pacific/Apia', NULL),
    ('XK', 'EUR', 'Europe/Belgrade', 'sq-XK'),
    ('YE', 'YER', 'Asia/Aden', 'ar-YE'),
    ('YT', 'EUR', 'Indian/Mayotte', 'fr-YT'),
    ('ZA', 'ZAR', 'Africa/Johannesburg', 'en-ZA'),
    ('ZM', 'ZMW', 'Africa/Lusaka', 'en-ZM'),
    ('ZW', 'ZWG', 'Africa/Harare', 'sn-ZW')
  ),
  derived AS (
    SELECT l."id",
           COALESCE(l."currency", d."currency") AS "currency",
           COALESCE(l."timeZone",
             (SELECT s."timezone"
                FROM public."location_schedules" AS s
               WHERE s."tenantId" = l."tenantId"
                 AND s."locationId" = l."id"
                 AND s."deletedAt" IS NULL
                 AND s."timezone" IN (SELECT z."name" FROM pg_catalog.pg_timezone_names AS z)
               LIMIT 1),
             d."timeZone") AS "timeZone",
           COALESCE(l."locale", d."locale") AS "locale"
      FROM public."locations" AS l
      LEFT JOIN defaults AS d ON d."country" = l."countryCode"
     WHERE (l."currency" IS NULL OR l."timeZone" IS NULL OR l."locale" IS NULL)
       AND (p_tenant IS NULL OR l."tenantId" = p_tenant)
  )
  UPDATE public."locations" AS l
     SET "currency" = x."currency",
         "timeZone" = x."timeZone",
         "locale" = x."locale"
    FROM derived AS x
   WHERE l."id" = x."id"
     AND (l."currency" IS DISTINCT FROM x."currency"
       OR l."timeZone" IS DISTINCT FROM x."timeZone"
       OR l."locale" IS DISTINCT FROM x."locale");
  GET DIAGNOSTICS updated = ROW_COUNT;
  RETURN updated;
END;
$$;

COMMENT ON FUNCTION public.dx_g1_backfill_location_regional(uuid) IS
  'GLOBAL-G1 fase 1: rellena moneda, zona y formato NULL de una sede desde su país (tabla de todos los países, Z1); nunca pisa un valor. Desaparece en fase 2.';

REVOKE ALL ON FUNCTION public.dx_g1_backfill_location_regional(uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION public.dx_g1_backfill_location_regional(uuid) TO dentalix_app;
  END IF;
END
$$;
