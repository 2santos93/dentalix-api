import { Prisma } from '@prisma/client';
import type { ZonedPeriodBranch } from '../../../shared/time/civil-day';

/**
 * Un instante como `timestamp` UTC, el tipo de las columnas: un `Date` de
 * Prisma llega como `timestamptz`, y comparar la columna con él obliga a
 * convertirla fila a fila y deja al planificador sin estimación (DX-423: un
 * bucle anidado de 200.000 vueltas en lugar de un hash join).
 */
export function utcTimestamp(instant: Date): Prisma.Sql {
  return Prisma.sql`(${instant.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
}

/**
 * `(sede IN (…) AND instante en [inicio, fin))`, una rama por ZONA (DX-097):
 * cada sede corta sus días a la medianoche de su zona, y la consulta sigue
 * pudiendo usar el índice (tenantId, sede, instante). Sin sedes, FALSE.
 * Lo comparten los reportes (DX-014, DX-423).
 */
export function inPeriod(
  location: Prisma.Sql,
  instant: Prisma.Sql,
  branches: readonly ZonedPeriodBranch[],
): Prisma.Sql {
  if (branches.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`(${Prisma.join(
    branches.map(
      (b) =>
        Prisma.sql`(${location} = ANY(${b.locationIds}::uuid[]) AND ${instant} >= ${utcTimestamp(b.start)} AND ${instant} < ${utcTimestamp(b.end)})`,
    ),
    ' OR ',
  )})`;
}

/** El instante más temprano y el más tardío de las ramas (acota el índice). */
export function periodWindow(branches: readonly ZonedPeriodBranch[]): {
  start: Date;
  end: Date;
} {
  return {
    start: new Date(Math.min(...branches.map((b) => b.start.getTime()))),
    end: new Date(Math.max(...branches.map((b) => b.end.getTime()))),
  };
}
