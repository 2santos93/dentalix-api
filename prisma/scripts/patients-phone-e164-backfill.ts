/**
 * DX-224 (A1): `npm run phones:e164-backfill` — relleno manual e idempotente de
 * `phoneE164` (la misma lógica que el trabajo programado
 * `patients.phone-e164-backfill`, que ya lo hace solo cada hora). Corre con el
 * rol de la app (DATABASE_URL, RLS FORCE). Imprime solo recuentos.
 */
import { config as loadDotenv } from 'dotenv';
import { Prisma } from '@prisma/client';
import { backfillTenantPhoneE164 } from '../../src/modules/patients/infrastructure/phone-e164-backfill';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const prisma = new PrismaService(new TenantContextService());
  try {
    const tenants = await prisma.tenant.findMany({
      select: { id: true, subdomain: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const tenant of tenants) {
      const counts = await backfillTenantPhoneE164(prisma, tenant.id);
      console.log(
        JSON.stringify({
          event: 'phones.e164_backfill',
          subdomain: tenant.subdomain,
          ...counts,
        }),
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Sin el mensaje: un error de Prisma puede citar valores.
    const code =
      error instanceof Prisma.PrismaClientKnownRequestError
        ? error.code
        : error instanceof Error
          ? error.name
          : 'unknown';
    console.error(
      JSON.stringify({ event: 'phones.e164_backfill_failed', code }),
    );
    process.exit(1);
  });
}
