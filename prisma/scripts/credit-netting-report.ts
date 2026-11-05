/**
 * Diagnóstico de SOLO LECTURA (DX-399-bis): planes cuyas devoluciones y
 * traspasos de salida del saldo a favor superan lo que `credit-netting` logra
 * atribuir a sus abonos («salida descartada»). Son los planes que dejó el fallo
 * de DX-399-bis (la imputación, automática o manual, repartió el dinero ya
 * devuelto) o el caso de traspaso de ENTRADA y luego salida (limitación
 * conocida de la cascada). No escribe nada, no reimputa nada, no hay backfill.
 *
 *   npm run credit-netting:report                      # todas las clínicas
 *   npm run credit-netting:report -- --tenant <uuid>   # una clínica
 *
 * Corre con el rol de la app (DATABASE_URL, RLS FORCE). Una línea JSON por plan
 * afectado, solo con ids y céntimos enteros; sin afectados, solo el resumen.
 */
import { config as loadDotenv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';
import { findAffectedPlans } from '../../src/modules/payments/infrastructure/allocations/credit-netting-facts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const argv = process.argv.slice(2);
  const at = argv.indexOf('--tenant');
  const only = at === -1 ? undefined : argv[at + 1];
  if (at !== -1 && (!only || !UUID.test(only))) {
    throw new Error('--tenant necesita el uuid de una clínica.');
  }
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService, { strict: false });
    const context = app.get(TenantContextService, { strict: false });
    const tenants = only
      ? [only]
      : (
          await prisma.tenant.findMany({
            where: { deletedAt: null },
            select: { id: true },
          })
        ).map((t) => t.id);
    let affected = 0;
    for (const tenantId of tenants) {
      const plans = await context.run(tenantId, undefined, () =>
        prisma.runWithTenant((tx) => findAffectedPlans(tx, tenantId)),
      );
      for (const plan of plans) {
        console.log(
          JSON.stringify({
            event: 'payments.credit_netting_affected',
            ...plan,
          }),
        );
      }
      affected += plans.length;
    }
    console.log(
      JSON.stringify({
        event: 'payments.credit_netting_report',
        tenants: tenants.length,
        affectedPlans: affected,
      }),
    );
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(
      JSON.stringify({
        event: 'payments.credit_netting_report_failed',
        error: error instanceof Error ? error.message : 'unknown',
      }),
    );
    process.exit(1);
  });
}
