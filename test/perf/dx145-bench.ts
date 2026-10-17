/*
 * DX-145 · benchmark de la cartera por antigüedad con RLS real. NO forma parte
 * de la suite: se corre a mano (docs/perf/DX-145.md) contra una base DESECHABLE
 * sembrada con dx043-seed.sql + dx145-seed.sql. Levanta AppModule (sin HTTP),
 * fija el tenant A en el contexto como haría TenantContextInterceptor y mide
 * el caso de uso completo: sus consultas (sede, zonas, deudores con sus planes,
 * planes de pago y contacto de la página) por `dentalix_app` (sin
 * BYPASSRLS), el cálculo de cada paciente con computeBalances, el orden, los
 * totales y el contacto de la página. 1 calentamiento + RUNS medidas (15 por
 * defecto, `BENCH_RUNS` para cambiarlo); mediana y p95 (DX-155), con la carga
 * de la máquina al empezar y al acabar, porque la máquina es compartida.
 */
import { loadavg } from 'node:os';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../../src/app.module';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';
import {
  GetReceivablesAgingUseCase,
  type ReceivablesAgingInput,
} from '../../src/modules/receivables/application/use-cases/get-receivables-aging.use-case';

const TENANT_A = '00000000-0000-4000-a000-00000000000a';
const SEDE_A1 = '00000000-0000-4000-b000-0000000000a1';
const RUNS = Number(process.env.BENCH_RUNS ?? 15);

/** Percentil por el método del rango más cercano (muestra ya ordenada). */
function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];
}

function load(): string {
  return loadavg()
    .map((l) => l.toFixed(2))
    .join(' / ');
}

const CASES: [string, ReceivablesAgingInput][] = [
  ['Sede A1, página 1', { locationId: SEDE_A1 }],
  ['Sede A1, más de 90 días', { locationId: SEDE_A1, minAgeDays: 91 }],
  ['Toda la clínica (consolidada), página 1', {}],
];

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: false,
  });
  const context = app.get(TenantContextService);
  const useCase = app.get(GetReceivablesAgingUseCase);
  const lines: string[] = [];
  const loadBefore = load();
  for (const [title, input] of CASES) {
    const times: number[] = [];
    let total = 0;
    for (let i = 0; i <= RUNS; i++) {
      const start = process.hrtime.bigint();
      const page = await context.run(TENANT_A, () => useCase.execute(input));
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      total = page.total;
      if (i > 0) times.push(ms);
    }
    times.sort((a, b) => a - b);
    const median = percentile(times, 0.5);
    const p95 = percentile(times, 0.95);
    lines.push(
      `| ${title} | ${total} deudores | ${median.toFixed(0)} ms | ${p95.toFixed(0)} ms | ${times[0].toFixed(0)}–${times[times.length - 1].toFixed(0)} ms |`,
    );
  }
  await app.close();
  console.log(
    `Carga (1/5/15 min): ${loadBefore} al empezar, ${load()} al acabar; ${RUNS} medidas por caso`,
  );
  console.log('| Caso | Filas | Mediana | p95 | Mín–máx |');
  console.log('|---|---|---|---|---|');
  for (const line of lines) console.log(line);
}

void main();
