/**
 * Backfill de imputaciones de abonos (DX-051, spec R17): crea las bases de los
 * abonos anteriores a la función y reparte cada plan con la regla automática,
 * clínica por clínica. Corre con el rol de la app (DATABASE_URL, RLS FORCE),
 * nunca como superusuario. Idempotente: una segunda pasada no cambia nada.
 *
 *   npm run allocations:backfill                       # todas las clínicas
 *   npm run allocations:backfill -- --tenant <uuid>    # una clínica
 *   npm run allocations:backfill -- --dry-run          # solo cuenta
 *
 * Imprime una línea JSON por clínica, solo con números.
 */
import { config as loadDotenv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { ConvertAmountUseCase } from '../src/modules/exchange/application/use-cases/convert-amount.use-case';
import { backfillPaymentAllocations } from '../src/modules/payments/application/backfill-payment-allocations';
import { PlanAllocationRebalancer } from '../src/modules/payments/application/plan-allocation-rebalancer';
import {
  PLAN_ALLOCATION_REPOSITORY,
  type PlanAllocationRepository,
} from '../src/modules/payments/domain/ports/plan-allocation-repository.port';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseTenant(argv: string[]): string | undefined {
  const at = argv.indexOf('--tenant');
  if (at === -1) return undefined;
  const value = argv[at + 1];
  if (!value || !UUID.test(value)) {
    throw new Error('--tenant necesita el uuid de una clínica.');
  }
  return value;
}

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const argv = process.argv.slice(2);
  const tenantId = parseTenant(argv);
  const dryRun = argv.includes('--dry-run');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const reports = await backfillPaymentAllocations(
      {
        repo: app.get<PlanAllocationRepository>(PLAN_ALLOCATION_REPOSITORY, {
          strict: false,
        }),
        rebalancer: app.get(PlanAllocationRebalancer, { strict: false }),
        convertAmount: app.get(ConvertAmountUseCase, { strict: false }),
        tenantContext: app.get(TenantContextService, { strict: false }),
      },
      { tenantId, dryRun },
    );
    for (const report of reports) {
      console.log(
        JSON.stringify({
          event: dryRun
            ? 'payments.allocation_backfill_dry_run'
            : 'payments.allocation_backfill',
          ...report,
        }),
      );
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: 'payments.allocation_backfill_failed',
      error: error instanceof Error ? error.message : 'unknown',
    }),
  );
  process.exit(1);
});
