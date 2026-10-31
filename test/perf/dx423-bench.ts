/*
 * DX-423 · benchmark de «Producción por procedimiento» con RLS real. NO forma
 * parte de la suite: se corre a mano (docs/perf/DX-423.md) contra una base
 * DESECHABLE sembrada con dx423-seed.sql. Levanta AppModule (sin HTTP), fija
 * el tenant en el contexto como TenantContextInterceptor y mide el caso de
 * uso entero (sedes, zonas, agregado, «Sin atribuir», profesionales y
 * categorías) por `dentalix_app` (sin BYPASSRLS). 1 calentamiento + RUNS
 * medidas (15 por defecto, `BENCH_RUNS`); mediana, p95 y la carga.
 */
import { loadavg } from 'node:os';
import { NestFactory } from '@nestjs/core';
import { ClinicRole } from '@prisma/client';
import { AppModule } from '../../src/app.module';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';
import {
  GetProductionByProcedureUseCase,
  type ProductionFiltersInput,
} from '../../src/modules/reports/application/use-cases/get-production-by-procedure.use-case';

const TENANT = '00000000-0000-4000-a000-000000000423';
const RUNS = Number(process.env.BENCH_RUNS ?? 15);
const ADMIN = {
  userId: '00000000-0000-4000-a000-0000000000ff',
  role: ClinicRole.ADMIN,
};

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function load(): string {
  return loadavg()
    .map((l) => l.toFixed(2))
    .join(' / ');
}

type Case = Omit<ProductionFiltersInput, 'allowedLocationIds'>;

const CASES: [string, Case][] = [
  [
    '24 meses, toda la clínica (ADMIN)',
    { from: '2024-11-01', to: '2026-10-31', actor: ADMIN },
  ],
  [
    '12 meses, toda la clínica',
    { from: '2025-11-01', to: '2026-10-31', actor: ADMIN },
  ],
  [
    '1 mes, toda la clínica',
    { from: '2026-10-01', to: '2026-10-31', actor: ADMIN },
  ],
  [
    '24 meses, un profesional',
    {
      from: '2024-11-01',
      to: '2026-10-31',
      actor: ADMIN,
      professionalId: 'ed5c9833-3a43-ba65-4d9d-9e6687ebb509',
    },
  ],
  [
    '24 meses, una categoría',
    {
      from: '2024-11-01',
      to: '2026-10-31',
      actor: ADMIN,
      category: 'Categoría 3',
    },
  ],
];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const context = app.get(TenantContextService);
  const useCase = app.get(GetProductionByProcedureUseCase);
  const lines: string[] = [];
  const loadBefore = load();
  for (const [title, input] of CASES) {
    const times: number[] = [];
    let count = 0;
    for (let i = 0; i <= RUNS; i++) {
      const start = process.hrtime.bigint();
      const report = await context.run(TENANT, () =>
        useCase.execute({ ...input, allowedLocationIds: 'ALL' }),
      );
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      count = report.totals.reduce((n, t) => n + t.count, 0);
      if (i > 0) times.push(ms);
    }
    times.sort((a, b) => a - b);
    lines.push(
      `| ${title} | ${count} ítems | ${percentile(times, 0.5).toFixed(0)} ms | ${percentile(times, 0.95).toFixed(0)} ms | ${times[0].toFixed(0)}–${times[times.length - 1].toFixed(0)} ms |`,
    );
  }
  await app.close();
  console.log(
    `Carga (1/5/15 min): ${loadBefore} al empezar, ${load()} al acabar; ${RUNS} medidas por caso`,
  );
  console.log('| Caso | Volumen del período | Mediana | p95 | Mín–máx |');
  console.log('|---|---|---|---|---|');
  for (const line of lines) console.log(line);
}

void main();
