import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  buildRouteAccessExport,
  serializeRouteAccessExport,
} from './route-access-export';

/**
 * DX-208: `npm run matrix:export [fichero]` escribe la matriz de autorización
 * en JSON (por defecto `dist/route-access.json`). No necesita base ni entorno:
 * solo el cliente de Prisma generado (los enums de rol y permiso).
 */
const out = path.resolve(process.argv[2] ?? 'dist/route-access.json');
const data = buildRouteAccessExport();
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, serializeRouteAccessExport(data));
console.log(
  `route-access.json: ${Object.keys(data.routes).length} rutas → ${out}`,
);
