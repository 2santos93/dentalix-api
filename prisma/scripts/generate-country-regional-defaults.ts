/**
 * Z1: genera la tabla país → {moneda, zona, formato} con la que el barrido de
 * fase 1 de GLOBAL-G1 (`dx_g1_backfill_location_regional`) rellena una sede
 * anterior a G1 que tiene país pero no datos regionales. Una fila por CADA
 * país de `prisma/reference/iso3166-countries.json`: ningún país tiene un
 * caso propio en el código.
 *
 * Se ejecuta UNA vez, a mano (Node 24, ICU del runtime), y su salida se revisa y se
 * versiona; no corre en runtime ni en el despliegue:
 *
 *   npx ts-node --transpile-only prisma/scripts/generate-country-regional-defaults.ts
 *
 * Escribe `prisma/reference/country-regional-defaults.json` e imprime por
 * stdout la lista `VALUES` que se pega en la migración
 * `…_regional_backfill_por_pais` (un test comprueba que son iguales).
 *
 * Reglas (las mismas que la propuesta de la web al dar de alta una sede, R1:
 * `dentalix-web/scripts/generate-country-regional.mjs` y
 * `src/lib/locations/country-regional.ts`):
 *   - moneda: la de uso general del país según `country-state-city`, con las
 *     mismas correcciones de códigos retirados (y la decisión del dueño para
 *     VE, V1), y solo si está en la lista ISO 4217 admitida;
 *   - zona: la única zona IANA del país; con varias, ninguna (la propuesta
 *     de la web tampoco elige: se elige en Ajustes). El barrido prefiere
 *     siempre la zona del horario vivo de la sede;
 *   - formato: el idioma principal del país según CLDR con su región
 *     (`Intl.Locale('und-XX').maximize()`), si este runtime sabe formatear en
 *     él; si no, ninguno.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Country } from 'country-state-city';
import { ISO4217_CURRENCIES } from '../reference/iso4217';

export interface CountryRegionalDefault {
  country: string;
  currency: string | null;
  timeZone: string | null;
  locale: string | null;
}

const ROOT = join(__dirname, '..', '..');

// Iguales que FIX_CURRENCY / FIX_ZONES del generador de la web (R1, V1).
const FIX_CURRENCY: Record<string, string> = {
  VE: 'USD',
  HR: 'EUR',
  BG: 'EUR',
  CW: 'XCG',
  SX: 'XCG',
  MR: 'MRU',
  SL: 'SLE',
  ST: 'STN',
  ZW: 'ZWG',
  PA: 'USD',
};
const FIX_ZONES: Record<string, string[]> = {
  BQ: ['America/Kralendijk'],
  SX: ['America/Lower_Princes'],
  BV: [],
  HM: [],
};

function countryLocale(country: string): string | null {
  const language = new Intl.Locale(`und-${country}`).maximize().language;
  if (language === 'und') return null;
  const [canonical] = Intl.getCanonicalLocales(`${language}-${country}`);
  return Intl.NumberFormat.supportedLocalesOf([language]).length > 0
    ? canonical
    : null;
}

export function build(): CountryRegionalDefault[] {
  const countries = JSON.parse(
    readFileSync(
      join(ROOT, 'prisma', 'reference', 'iso3166-countries.json'),
      'utf8',
    ),
  ) as { code: string }[];
  const iana = new Set(
    JSON.parse(
      readFileSync(
        join(ROOT, 'prisma', 'reference', 'iana-zone-names.json'),
        'utf8',
      ),
    ) as string[],
  );
  const admitted = new Set(ISO4217_CURRENCIES.map((c) => c.code));
  return countries.map(({ code }) => {
    const source = Country.getCountryByCode(code);
    const currency = FIX_CURRENCY[code] ?? source?.currency?.split(',')[0];
    const zones = (
      FIX_ZONES[code] ?? (source?.timezones ?? []).map((t) => t.zoneName)
    ).filter((zone) => iana.has(zone));
    return {
      country: code,
      currency: currency && admitted.has(currency) ? currency : null,
      timeZone: zones.length === 1 ? zones[0] : null,
      locale: countryLocale(code),
    };
  });
}

const sql = (value: string | null): string =>
  value === null ? 'NULL' : `'${value.replace(/'/g, "''")}'`;

export function valuesSql(rows: readonly CountryRegionalDefault[]): string {
  return rows
    .map(
      (r) =>
        `    (${sql(r.country)}, ${sql(r.currency)}, ${sql(r.timeZone)}, ${sql(r.locale)})`,
    )
    .join(',\n');
}

if (require.main === module) {
  const rows = build();
  writeFileSync(
    join(ROOT, 'prisma', 'reference', 'country-regional-defaults.json'),
    JSON.stringify(rows, null, 2) + '\n',
  );
  process.stdout.write(valuesSql(rows) + '\n');
}
