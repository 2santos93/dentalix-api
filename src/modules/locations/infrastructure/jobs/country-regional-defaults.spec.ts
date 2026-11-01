import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ISO3166_COUNTRIES } from '../../../../../prisma/reference/iso3166';
import { ISO4217_CURRENCIES } from '../../../../../prisma/reference/iso4217';
import {
  type CountryRegionalDefault,
  valuesSql,
} from '../../../../../prisma/scripts/generate-country-regional-defaults';

/**
 * Z1: el barrido de fase 1 de GLOBAL-G1 deriva moneda, zona y formato de una
 * tabla con todos los países, no de un caso por país. La tabla versionada
 * (`country-regional-defaults.json`) y la lista `VALUES` de la migración son
 * la misma, y la última definición de la función no nombra ningún país.
 */
const ROOT = join(__dirname, '..', '..', '..', '..', '..');
const MIGRATIONS = join(ROOT, 'prisma', 'migrations');
const DEFAULTS = JSON.parse(
  readFileSync(
    join(ROOT, 'prisma', 'reference', 'country-regional-defaults.json'),
    'utf8',
  ),
) as CountryRegionalDefault[];
const IANA = new Set<string>(
  JSON.parse(
    readFileSync(
      join(ROOT, 'prisma', 'reference', 'iana-zone-names.json'),
      'utf8',
    ),
  ) as string[],
);
const FUNCTION = 'dx_g1_backfill_location_regional';

/** Migraciones que (re)definen la función, en orden de aplicación. */
const definitions = readdirSync(MIGRATIONS)
  .filter((name) => !name.endsWith('.toml'))
  .sort()
  .map((name) => ({
    name,
    sql: readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8'),
  }))
  .filter(({ sql }) =>
    sql.includes(`CREATE OR REPLACE FUNCTION public.${FUNCTION}(`),
  );
const latest = definitions[definitions.length - 1];

describe('country → regional defaults of the G1 backfill (Z1)', () => {
  it('has one row per ISO 3166 country, in the same order, and nothing else', () => {
    expect(DEFAULTS.map((d) => d.country)).toEqual(
      ISO3166_COUNTRIES.map((c) => c.code),
    );
  });

  it('only proposes admitted currencies, IANA zones and locales of that country', () => {
    const admitted = new Set(ISO4217_CURRENCIES.map((c) => c.code));
    for (const d of DEFAULTS) {
      if (d.currency !== null) expect(admitted.has(d.currency)).toBe(true);
      if (d.timeZone !== null) expect(IANA.has(d.timeZone)).toBe(true);
      if (d.locale !== null) {
        expect(Intl.getCanonicalLocales(d.locale)).toEqual([d.locale]);
        expect(new Intl.Locale(d.locale).region).toBe(d.country);
      }
    }
    // Casi todos los países tienen moneda y formato: la tabla no está vacía
    // por accidente.
    expect(DEFAULTS.filter((d) => d.currency).length).toBeGreaterThan(230);
    expect(DEFAULTS.filter((d) => d.locale).length).toBeGreaterThan(230);
    expect(DEFAULTS.filter((d) => d.timeZone).length).toBeGreaterThan(180);
  });

  it('the latest definition of the function carries exactly this table', () => {
    expect(latest.name).toBe('20261111110000_regional_backfill_por_pais');
    expect(latest.sql).toContain(valuesSql(DEFAULTS));
  });

  it('the latest definition names no country in its logic: it joins the table by the location country code', () => {
    const body = latest.sql.slice(latest.sql.indexOf('derived AS ('));
    expect(body).toContain('d."country" = l."countryCode"');
    expect(body).not.toMatch(/'[A-Z]{2}'/);
    expect(latest.sql).not.toMatch(/WHEN\s+'[A-Z]{2}'/);
  });
});
