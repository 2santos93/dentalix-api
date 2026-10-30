-- Excepción G5.3 (DX-334): país de sede anterior a DX-312.
--
-- DX-312 (epic DX-311 «Producto global, sin supuestos de país»), fase 1: el
-- país de la sede es un código ISO 3166-1 alfa-2 cualquiera de "countries",
-- en una columna propia ("countryCode", con FK), obligatorio y sin valor por
-- defecto.
--
-- La columna de siempre ("country", enum "ClinicCountry") se queda para las
-- réplicas anteriores, que no conocen la nueva (Prisma solo selecciona las
-- columnas de su esquema) y solo saben leer los dos valores del enum. Pasa a
-- admitir NULL y la mantiene el trigger locations_country_code con la
-- proyección dx_legacy_clinic_country: los dos códigos del enum se proyectan
-- a sí mismos y cualquier otro país a NULL. Nunca se proyecta un país a otro:
-- una réplica anterior que lee una sede de otro país falla en esa clínica (la
-- RLS la acota) en lugar de tratarla como si fuera de un país que no es.
-- Igual en pending_registrations ("locationCountryCode").
--
-- Paso 0 del trigger: rechaza el INSERT sin "countryCode" y sin moneda, zona,
-- formato ni revisión. Es la forma exacta con que el registro legado de la
-- API anterior crea la sede: su cliente de Prisma pone él mismo el país por
-- defecto de su esquema, así que sin el paso 0 una clínica de cualquier país
-- nacería con ese país. Las altas de sede y los registros con sede de la API
-- anterior mandan siempre los cuatro datos regionales, y la API nueva manda
-- siempre "countryCode": esas formas pasan. Va en el trigger y no en un CHECK
-- porque un CHECK no distingue INSERT de UPDATE.
--
-- "countries" se siembra aquí con la lista generada
-- (prisma/reference/iso3166.ts) y los nombres en español, para que la FK
-- valga también en una base que nunca corrió `prisma db seed`. Las filas que
-- ya hubiera y no estén en la lista se quedan (las referencian patients y
-- cities).
--
-- prescriptions."country" pasa a admitir NULL: la receta única de una sede
-- de otro país no tiene país legado. El CHECK legado no exige el país (con
-- NULL vale NULL y se cumple), así que va uno propio que lo exige en las
-- recetas legadas.
--
-- Esta migración no rellena nada: el relleno por clínica es 20261031120100,
-- y la comprobación, la validación de las FK y del CHECK y el NOT NULL de
-- "countryCode" son 20261031120200. Hasta entonces no hay ninguna
-- restricción sobre "countryCode" salvo la FK (que no mira los NULL): una
-- UPDATE de una sede aún sin rellenar pasa igual que hoy. El valor por
-- defecto de la columna antigua lo quita 20261031120300. La fase 2 (ticket
-- aparte) borra el trigger, las funciones y las columnas antiguas.
--
-- ADD COLUMN, DROP NOT NULL, ADD CONSTRAINT … NOT VALID y CREATE TRIGGER
-- toman un ACCESS EXCLUSIVE breve sobre locations, pending_registrations y
-- prescriptions, sin recorrer la tabla. lock_timeout 5 s: si una transacción
-- larga lo retiene, falla limpia; para reintentar, `npx prisma migrate
-- resolve --rolled-back 20261031120000_dx312_location_country_code` y de
-- nuevo el deploy. RLS FORCE no se toca.

SET LOCAL lock_timeout = '5s';

-- Lista generada por prisma/scripts/generate-iso3166.ts (no editar a mano).
INSERT INTO "countries" ("code", "name") VALUES
  ('AD', 'Andorra'),
  ('AE', 'Emiratos Árabes Unidos'),
  ('AF', 'Afganistán'),
  ('AG', 'Antigua y Barbuda'),
  ('AI', 'Anguila'),
  ('AL', 'Albania'),
  ('AM', 'Armenia'),
  ('AO', 'Angola'),
  ('AQ', 'Antártida'),
  ('AR', 'Argentina'),
  ('AS', 'Samoa Americana'),
  ('AT', 'Austria'),
  ('AU', 'Australia'),
  ('AW', 'Aruba'),
  ('AX', 'Islas Aland'),
  ('AZ', 'Azerbaiyán'),
  ('BA', 'Bosnia y Herzegovina'),
  ('BB', 'Barbados'),
  ('BD', 'Bangladés'),
  ('BE', 'Bélgica'),
  ('BF', 'Burkina Faso'),
  ('BG', 'Bulgaria'),
  ('BH', 'Baréin'),
  ('BI', 'Burundi'),
  ('BJ', 'Benín'),
  ('BL', 'San Bartolomé'),
  ('BM', 'Bermudas'),
  ('BN', 'Brunéi'),
  ('BO', 'Bolivia'),
  ('BQ', 'Caribe neerlandés'),
  ('BR', 'Brasil'),
  ('BS', 'Bahamas'),
  ('BT', 'Bután'),
  ('BV', 'Isla Bouvet'),
  ('BW', 'Botsuana'),
  ('BY', 'Bielorrusia'),
  ('BZ', 'Belice'),
  ('CA', 'Canadá'),
  ('CC', 'Islas Cocos'),
  ('CD', 'República Democrática del Congo'),
  ('CF', 'República Centroafricana'),
  ('CG', 'Congo'),
  ('CH', 'Suiza'),
  ('CI', 'Côte d’Ivoire'),
  ('CK', 'Islas Cook'),
  ('CL', 'Chile'),
  ('CM', 'Camerún'),
  ('CN', 'China'),
  ('CO', 'Colombia'),
  ('CR', 'Costa Rica'),
  ('CU', 'Cuba'),
  ('CV', 'Cabo Verde'),
  ('CW', 'Curazao'),
  ('CX', 'Isla de Navidad'),
  ('CY', 'Chipre'),
  ('CZ', 'Chequia'),
  ('DE', 'Alemania'),
  ('DJ', 'Yibuti'),
  ('DK', 'Dinamarca'),
  ('DM', 'Dominica'),
  ('DO', 'República Dominicana'),
  ('DZ', 'Argelia'),
  ('EC', 'Ecuador'),
  ('EE', 'Estonia'),
  ('EG', 'Egipto'),
  ('EH', 'Sáhara Occidental'),
  ('ER', 'Eritrea'),
  ('ES', 'España'),
  ('ET', 'Etiopía'),
  ('FI', 'Finlandia'),
  ('FJ', 'Fiyi'),
  ('FK', 'Islas Malvinas'),
  ('FM', 'Micronesia'),
  ('FO', 'Islas Feroe'),
  ('FR', 'Francia'),
  ('GA', 'Gabón'),
  ('GB', 'Reino Unido'),
  ('GD', 'Granada'),
  ('GE', 'Georgia'),
  ('GF', 'Guayana Francesa'),
  ('GG', 'Guernesey'),
  ('GH', 'Ghana'),
  ('GI', 'Gibraltar'),
  ('GL', 'Groenlandia'),
  ('GM', 'Gambia'),
  ('GN', 'Guinea'),
  ('GP', 'Guadalupe'),
  ('GQ', 'Guinea Ecuatorial'),
  ('GR', 'Grecia'),
  ('GS', 'Islas Georgia del Sur y Sandwich del Sur'),
  ('GT', 'Guatemala'),
  ('GU', 'Guam'),
  ('GW', 'Guinea-Bisáu'),
  ('GY', 'Guyana'),
  ('HK', 'RAE de Hong Kong (China)'),
  ('HM', 'Islas Heard y McDonald'),
  ('HN', 'Honduras'),
  ('HR', 'Croacia'),
  ('HT', 'Haití'),
  ('HU', 'Hungría'),
  ('ID', 'Indonesia'),
  ('IE', 'Irlanda'),
  ('IL', 'Israel'),
  ('IM', 'Isla de Man'),
  ('IN', 'India'),
  ('IO', 'Territorio Británico del Océano Índico'),
  ('IQ', 'Irak'),
  ('IR', 'Irán'),
  ('IS', 'Islandia'),
  ('IT', 'Italia'),
  ('JE', 'Jersey'),
  ('JM', 'Jamaica'),
  ('JO', 'Jordania'),
  ('JP', 'Japón'),
  ('KE', 'Kenia'),
  ('KG', 'Kirguistán'),
  ('KH', 'Camboya'),
  ('KI', 'Kiribati'),
  ('KM', 'Comoras'),
  ('KN', 'San Cristóbal y Nieves'),
  ('KP', 'Corea del Norte'),
  ('KR', 'Corea del Sur'),
  ('KW', 'Kuwait'),
  ('KY', 'Islas Caimán'),
  ('KZ', 'Kazajistán'),
  ('LA', 'Laos'),
  ('LB', 'Líbano'),
  ('LC', 'Santa Lucía'),
  ('LI', 'Liechtenstein'),
  ('LK', 'Sri Lanka'),
  ('LR', 'Liberia'),
  ('LS', 'Lesoto'),
  ('LT', 'Lituania'),
  ('LU', 'Luxemburgo'),
  ('LV', 'Letonia'),
  ('LY', 'Libia'),
  ('MA', 'Marruecos'),
  ('MC', 'Mónaco'),
  ('MD', 'Moldavia'),
  ('ME', 'Montenegro'),
  ('MF', 'San Martín'),
  ('MG', 'Madagascar'),
  ('MH', 'Islas Marshall'),
  ('MK', 'Macedonia del Norte'),
  ('ML', 'Mali'),
  ('MM', 'Myanmar (Birmania)'),
  ('MN', 'Mongolia'),
  ('MO', 'RAE de Macao (China)'),
  ('MP', 'Islas Marianas del Norte'),
  ('MQ', 'Martinica'),
  ('MR', 'Mauritania'),
  ('MS', 'Montserrat'),
  ('MT', 'Malta'),
  ('MU', 'Mauricio'),
  ('MV', 'Maldivas'),
  ('MW', 'Malaui'),
  ('MX', 'México'),
  ('MY', 'Malasia'),
  ('MZ', 'Mozambique'),
  ('NA', 'Namibia'),
  ('NC', 'Nueva Caledonia'),
  ('NE', 'Níger'),
  ('NF', 'Isla Norfolk'),
  ('NG', 'Nigeria'),
  ('NI', 'Nicaragua'),
  ('NL', 'Países Bajos'),
  ('NO', 'Noruega'),
  ('NP', 'Nepal'),
  ('NR', 'Nauru'),
  ('NU', 'Niue'),
  ('NZ', 'Nueva Zelanda'),
  ('OM', 'Omán'),
  ('PA', 'Panamá'),
  ('PE', 'Perú'),
  ('PF', 'Polinesia Francesa'),
  ('PG', 'Papúa Nueva Guinea'),
  ('PH', 'Filipinas'),
  ('PK', 'Pakistán'),
  ('PL', 'Polonia'),
  ('PM', 'San Pedro y Miquelón'),
  ('PN', 'Islas Pitcairn'),
  ('PR', 'Puerto Rico'),
  ('PS', 'Territorios Palestinos'),
  ('PT', 'Portugal'),
  ('PW', 'Palaos'),
  ('PY', 'Paraguay'),
  ('QA', 'Catar'),
  ('RE', 'Reunión'),
  ('RO', 'Rumanía'),
  ('RS', 'Serbia'),
  ('RU', 'Rusia'),
  ('RW', 'Ruanda'),
  ('SA', 'Arabia Saudí'),
  ('SB', 'Islas Salomón'),
  ('SC', 'Seychelles'),
  ('SD', 'Sudán'),
  ('SE', 'Suecia'),
  ('SG', 'Singapur'),
  ('SH', 'Santa Elena'),
  ('SI', 'Eslovenia'),
  ('SJ', 'Svalbard y Jan Mayen'),
  ('SK', 'Eslovaquia'),
  ('SL', 'Sierra Leona'),
  ('SM', 'San Marino'),
  ('SN', 'Senegal'),
  ('SO', 'Somalia'),
  ('SR', 'Surinam'),
  ('SS', 'Sudán del Sur'),
  ('ST', 'Santo Tomé y Príncipe'),
  ('SV', 'El Salvador'),
  ('SX', 'Sint Maarten'),
  ('SY', 'Siria'),
  ('SZ', 'Esuatini'),
  ('TC', 'Islas Turcas y Caicos'),
  ('TD', 'Chad'),
  ('TF', 'Territorios Australes Franceses'),
  ('TG', 'Togo'),
  ('TH', 'Tailandia'),
  ('TJ', 'Tayikistán'),
  ('TK', 'Tokelau'),
  ('TL', 'Timor-Leste'),
  ('TM', 'Turkmenistán'),
  ('TN', 'Túnez'),
  ('TO', 'Tonga'),
  ('TR', 'Turquía'),
  ('TT', 'Trinidad y Tobago'),
  ('TV', 'Tuvalu'),
  ('TW', 'Taiwán'),
  ('TZ', 'Tanzania'),
  ('UA', 'Ucrania'),
  ('UG', 'Uganda'),
  ('UM', 'Islas menores alejadas de EE. UU.'),
  ('US', 'Estados Unidos'),
  ('UY', 'Uruguay'),
  ('UZ', 'Uzbekistán'),
  ('VA', 'Ciudad del Vaticano'),
  ('VC', 'San Vicente y las Granadinas'),
  ('VE', 'Venezuela'),
  ('VG', 'Islas Vírgenes Británicas'),
  ('VI', 'Islas Vírgenes de EE. UU.'),
  ('VN', 'Vietnam'),
  ('VU', 'Vanuatu'),
  ('WF', 'Wallis y Futuna'),
  ('WS', 'Samoa'),
  ('XK', 'Kosovo'),
  ('YE', 'Yemen'),
  ('YT', 'Mayotte'),
  ('ZA', 'Sudáfrica'),
  ('ZM', 'Zambia'),
  ('ZW', 'Zimbabue')
ON CONFLICT ("code") DO UPDATE SET "name" = EXCLUDED."name";

-- Proyección del país de la sede a la columna antigua (la misma tabla que
-- src/shared/locations/legacy-clinic-country.ts).
CREATE FUNCTION public.dx_legacy_clinic_country(code text)
RETURNS public."ClinicCountry"
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE code
    WHEN 'CO' THEN 'CO'::public."ClinicCountry"
    WHEN 'ES' THEN 'ES'::public."ClinicCountry"
  END
$$;

-- El escritor anterior nunca da "countryCode" (no conoce la columna); el
-- cliente nuevo nunca da "country" (@ignore) y siempre da "countryCode".
-- Casos en la spec de DX-312, §3.3.
CREATE FUNCTION public.dx_location_country_code_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- 0. Registro legado de la API anterior: sin país propio ni datos
    -- regionales. Rechazado.
    IF NEW."countryCode" IS NULL
       AND NEW."currency" IS NULL
       AND NEW."timeZone" IS NULL
       AND NEW."locale" IS NULL
       AND NEW."regionalSettingsReviewedAt" IS NULL THEN
      RAISE EXCEPTION 'DX-312: una sede necesita país y datos regionales; el registro sin sede ya no se admite.'
        USING ERRCODE = 'check_violation',
              HINT = 'Elige el país y los datos regionales de la sede.';
    END IF;
    IF NEW."countryCode" IS NOT NULL THEN
      -- 2. Escritor nuevo: manda "countryCode" y pisa lo que trajera la
      -- columna antigua (también su valor por defecto).
      NEW."country" := public.dx_legacy_clinic_country(NEW."countryCode");
    ELSIF NEW."country" IS NOT NULL THEN
      -- 1. Escritor anterior.
      NEW."countryCode" := NEW."country"::text;
    END IF;
    -- 3. Los dos NULL: nada; el NOT NULL de "countryCode" la rechaza.
  ELSIF NEW."countryCode" IS DISTINCT FROM OLD."countryCode" THEN
    -- Cambia "countryCode" (escritor nuevo, relleno u ON UPDATE CASCADE).
    NEW."country" := public.dx_legacy_clinic_country(NEW."countryCode");
  ELSIF NEW."country" IS DISTINCT FROM OLD."country" THEN
    -- Cambia solo la antigua (escritor anterior).
    NEW."countryCode" := NEW."country"::text;
  END IF;
  RETURN NEW;
END;
$$;

-- Las mismas reglas en los pendientes, sin paso 0: un pendiente sin sede
-- no puede llegar a ser una sede (lo rechaza el paso 0 de las sedes).
CREATE FUNCTION public.dx_pending_registration_country_code_sync() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."locationCountryCode" IS NOT NULL THEN
      NEW."locationCountry" := public.dx_legacy_clinic_country(NEW."locationCountryCode");
    ELSIF NEW."locationCountry" IS NOT NULL THEN
      NEW."locationCountryCode" := NEW."locationCountry"::text;
    END IF;
  ELSIF NEW."locationCountryCode" IS DISTINCT FROM OLD."locationCountryCode" THEN
    NEW."locationCountry" := public.dx_legacy_clinic_country(NEW."locationCountryCode");
  ELSIF NEW."locationCountry" IS DISTINCT FROM OLD."locationCountry" THEN
    NEW."locationCountryCode" := NEW."locationCountry"::text;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "locations"
  ADD COLUMN "countryCode" CHAR(2),
  ALTER COLUMN "country" DROP NOT NULL;

ALTER TABLE "locations"
  ADD CONSTRAINT "locations_country_code_fkey" FOREIGN KEY ("countryCode")
    REFERENCES "countries"("code") ON DELETE RESTRICT ON UPDATE CASCADE
    NOT VALID;

CREATE TRIGGER "locations_country_code"
  BEFORE INSERT OR UPDATE OF "country", "countryCode" ON "locations"
  FOR EACH ROW EXECUTE FUNCTION public.dx_location_country_code_sync();

ALTER TABLE "pending_registrations"
  ADD COLUMN "locationCountryCode" CHAR(2);

ALTER TABLE "pending_registrations"
  ADD CONSTRAINT "pending_registrations_location_country_code_fkey"
    FOREIGN KEY ("locationCountryCode") REFERENCES "countries"("code")
    ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

CREATE TRIGGER "pending_registrations_location_country_code"
  BEFORE INSERT OR UPDATE OF "locationCountry", "locationCountryCode" ON "pending_registrations"
  FOR EACH ROW EXECUTE FUNCTION public.dx_pending_registration_country_code_sync();

-- Recetas: el país legado pasa a admitir NULL (solo catálogo) y un CHECK
-- propio lo exige en las recetas legadas. "country" IS NOT NULL nunca vale
-- NULL, así que en una receta legada sin país el CHECK da falso.
ALTER TABLE "prescriptions"
  ALTER COLUMN "country" DROP NOT NULL;

ALTER TABLE "prescriptions"
  ADD CONSTRAINT "prescriptions_legacy_country_present_check"
    CHECK ("singleFormat" OR "country" IS NOT NULL) NOT VALID;
