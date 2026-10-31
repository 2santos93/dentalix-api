/**
 * DX-083 (OPS-021): vuelca las ciudades de `country-state-city` a
 * `cities.json` junto al seed compilado, para que `node
 * dist/scripts/prisma/seed.js` corra en la imagen de runtime sin
 * devDependencies. Lo ejecuta `npm run build:scripts` (etapa de build del
 * Dockerfile); no hace falta a mano.
 */
import { writeFileSync } from 'node:fs';
import { CITIES_JSON, citiesFromPackage } from '../reference/cities';

const rows = citiesFromPackage();
writeFileSync(CITIES_JSON, JSON.stringify(rows));
console.log(`Exported ${rows.length} cities to ${CITIES_JSON}`);
