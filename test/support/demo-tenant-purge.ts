import type { PrismaClient } from '@prisma/client';
import { DEMO_EMAIL_DOMAIN, DEMO_SUBDOMAIN } from '../../prisma/seed-demo';
import { purgeTenants } from './tenant-purge';

/**
 * Borra (duro, solo en la base de test) todo tenant demo, vivo o retirado, y
 * sus usuarios `@DEMO_EMAIL_DOMAIN`. `raw` es el superusuario (DIRECT_URL).
 * Las tablas salen del catálogo (`tenant-purge.ts`, DX-396).
 */
export async function purgeDemoTenants(raw: PrismaClient): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: DEMO_SUBDOMAIN },
    select: { id: true },
  });
  await purgeTenants(
    raw,
    tenants.map((t) => t.id),
  );
  await raw.user.deleteMany({
    where: { email: { endsWith: `@${DEMO_EMAIL_DOMAIN}` } },
  });
}
