import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as CountryStateCity from 'country-state-city';

/** Una ciudad del seed de referencia (tabla global `cities`). */
export interface CitySeedRow {
  countryCode: string;
  name: string;
  /** Departamento/estado (informativo). */
  region: string | null;
}

/**
 * DX-083 (OPS-021): las ciudades salen de `country-state-city`, que es
 * devDependency (17 MB, GPL-3.0) y no va en la imagen de runtime. Al compilar
 * los scripts (`npm run build:scripts`) se vuelcan a `cities.json` junto al
 * seed compilado (dist/scripts/prisma/reference/), que se lee si existe. En
 * desarrollo (`npx prisma db seed` con ts-node) no hay JSON junto al fuente y
 * se leen del paquete.
 */
export const CITIES_JSON = join(__dirname, 'cities.json');

/** Ciudades de todos los países, agrupadas por país, como las da el paquete. */
export function citiesFromPackage(): CitySeedRow[] {
  // `require` perezoso: solo se carga cuando no hay JSON (en la imagen no
  // está instalado). Un `import()` no vale: jest no lo admite sin módulos ESM.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { Country, State, City } =
    require('country-state-city') as typeof CountryStateCity;
  const rows: CitySeedRow[] = [];
  for (const country of Country.getAllCountries()) {
    // Mapa stateCode -> nombre para poblar `region` (informativo).
    const stateName = new Map(
      State.getStatesOfCountry(country.isoCode).map((s) => [s.isoCode, s.name]),
    );
    for (const city of City.getCitiesOfCountry(country.isoCode) ?? []) {
      rows.push({
        countryCode: country.isoCode,
        name: city.name,
        region: city.stateCode ? (stateName.get(city.stateCode) ?? null) : null,
      });
    }
  }
  return rows;
}

export function loadCitySeedRows(file: string = CITIES_JSON): CitySeedRow[] {
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, 'utf8')) as CitySeedRow[];
  }
  return citiesFromPackage();
}
