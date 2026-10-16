/**
 * Comprobación tras el despliegue (DX-134): ninguna tabla de `public` con RLS
 * activada puede quedar sin FORCE. Si una migración `…_reforce_*` (o una con
 * NO FORCE/FORCE en su transacción) falla a medias, p. ej. por `lock_timeout`,
 * el owner de las migraciones deja de estar sujeto a la RLS de esa tabla y
 * nada más lo vigila fuera de la CI.
 *
 *   npm run db:check-force
 *
 * Usa DIRECT_URL (o DATABASE_URL): pg_class lo puede leer cualquier rol.
 * Salida: 0 si todo está bien; 1 y la lista de tablas si alguna no tiene
 * FORCE; 2 si no pudo comprobarlo. Recuperación: README, «Despliegue: roles
 * de la BD» (`prisma migrate resolve --rolled-back <migración>` + `deploy`).
 * Solo imprime nombres de tabla.
 */
import { PrismaClient } from '@prisma/client';

async function main(): Promise<number> {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DIRECT_URL o DATABASE_URL.');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    const rows = await prisma.$queryRaw<{ relname: string }[]>`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public'
         AND c.relrowsecurity AND NOT c.relforcerowsecurity
       ORDER BY c.relname`;
    const tables = rows.map((r) => r.relname);
    if (tables.length > 0) {
      console.error(JSON.stringify({ event: 'db.check_force_failed', tables }));
      return 1;
    }
    console.log(JSON.stringify({ event: 'db.check_force_ok' }));
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      JSON.stringify({
        event: 'db.check_force_error',
        error: err instanceof Error ? err.message : 'unknown',
      }),
    );
    process.exit(2);
  },
);
