/**
 * DX-113: entorno de los specs `*.owner-spec.ts` (job «Migraciones con owner
 * sin superusuario» de la CI; en local, ver README «Despliegue: roles de la BD»).
 *
 *   DIRECT_URL            owner de las migraciones SIN superusuario ni
 *                         BYPASSRLS, sobre una base ya migrada con él.
 *   DATABASE_URL          rol de la app (dentalix_app) sobre esa base.
 *   OWNER_NOSU_ADMIN_URL  admin del clúster (superusuario en la CI): crea y
 *                         borra bases desechables y carga filas saltando la RLS.
 */
export interface OwnerNosuEnv {
  ownerUrl: string;
  adminUrl: string;
  owner: string;
}

export function requireOwnerNosuEnv(): OwnerNosuEnv {
  const ownerUrl = process.env.DIRECT_URL;
  const adminUrl = process.env.OWNER_NOSU_ADMIN_URL;
  if (!ownerUrl || !adminUrl || !process.env.DATABASE_URL) {
    throw new Error(
      'owner-nosu: faltan DIRECT_URL, DATABASE_URL u OWNER_NOSU_ADMIN_URL (ver test/owner-nosu/owner-nosu-env.ts).',
    );
  }
  return {
    ownerUrl,
    adminUrl,
    owner: decodeURIComponent(new URL(ownerUrl).username),
  };
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

export const ownerUrlFor = (env: OwnerNosuEnv, db: string): string =>
  withDatabase(env.ownerUrl, db);

export const adminUrlFor = (env: OwnerNosuEnv, db: string): string =>
  withDatabase(env.adminUrl, db);
