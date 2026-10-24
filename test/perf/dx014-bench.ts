/*
 * DX-014 · benchmark de «Comparar sedes» con RLS real. NO forma parte de la
 * suite: se corre a mano (docs/perf/DX-014.md) contra una base DESECHABLE
 * sembrada con dx014-seed.sql. Levanta AppModule (sin HTTP), fija el tenant en
 * el contexto como TenantContextInterceptor y mide el caso de uso entero
 * (sedes, zonas y las consultas agregadas de los dos períodos) por
 * `dentalix_app` (sin BYPASSRLS). 1 calentamiento + RUNS medidas (15 por
 * defecto, `BENCH_RUNS`); mediana, p95 y la carga de la máquina.
 */
import { loadavg } from 'node:os';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';
import {
  GetLocationsComparisonUseCase,
  type LocationsComparisonInput,
} from '../../src/modules/reports/application/use-cases/get-locations-comparison.use-case';

const TENANT = '00000000-0000-4000-a000-0000000000d1';
const RUNS = Number(process.env.BENCH_RUNS ?? 15);

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function load(): string {
  return loadavg()
    .map((l) => l.toFixed(2))
    .join(' / ');
}

const CASES: [string, Omit<LocationsComparisonInput, 'allowedLocationIds'>][] =
  [
    [
      'Mes (octubre) vs período anterior',
      { from: '2026-10-01', to: '2026-10-24', compare: 'previous' },
    ],
    [
      '12 meses vs los 12 anteriores',
      { from: '2025-10-25', to: '2026-10-24', compare: 'previous' },
    ],
    [
      '12 meses vs año anterior',
      { from: '2025-10-25', to: '2026-10-24', compare: 'previous_year' },
    ],
    [
      '366 días sin comparación',
      { from: '2025-10-24', to: '2026-10-24', compare: 'none' },
    ],
  ];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const context = app.get(TenantContextService);
  const useCase = app.get(GetLocationsComparisonUseCase);
  const lines: string[] = [];
  const loadBefore = load();
  for (const [title, input] of CASES) {
    const times: number[] = [];
    let completed = 0;
    for (let i = 0; i <= RUNS; i++) {
      const start = process.hrtime.bigint();
      const report = await context.run(TENANT, () =>
        useCase.execute({ ...input, allowedLocationIds: 'ALL' }),
      );
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      completed = report.total.metrics.completedAppointments.value ?? 0;
      if (i > 0) times.push(ms);
    }
    times.sort((a, b) => a - b);
    lines.push(
      `| ${title} | ${completed} atendidas | ${percentile(times, 0.5).toFixed(0)} ms | ${percentile(times, 0.95).toFixed(0)} ms | ${times[0].toFixed(0)}–${times[times.length - 1].toFixed(0)} ms |`,
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
