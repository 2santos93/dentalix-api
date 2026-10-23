import { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { App } from 'supertest/types';
import { buildXlsx } from '../src/modules/patient-imports/domain/__fixtures__/xlsx-builder';
import { createE2eApp } from './support/create-e2e-app';
import { Clinic, registerClinic, resetDatabase } from './support/e2e-fixtures';
import {
  listenOnEphemeralPort,
  type ListeningApp,
} from './support/listening-app';

// SEC-046 · Prueba de carga LENTA (unos 30–60 s): 20 lecturas de importación
// en paralelo con el XLSX de la auditoría (4.000 cadenas compartidas de
// ~4.500 caracteres y 9.000 filas × 30 columnas que las referencian, ~28 MB
// descomprimidos) y una clínica víctima que lista pacientes cada 250 ms. Mide
// el pico de RSS del proceso y la latencia de la víctima.
//
// No corre por defecto (ni en CI): `RUN_SLOW_TESTS=1 npm run test:e2e --
// test/patient-imports-load`. Solo usa HTTP, así que la misma suite mide el
// código anterior a SEC-046 (sin tope) para comparar.
const SLOW = process.env.RUN_SLOW_TESTS === '1';
const describeSlow = SLOW
  ? describe
  : (name: string, fn: () => void) =>
      describe.skip(`${name} [SALTADO: RUN_SLOW_TESTS=1 para correrla]`, fn);

const PARALLEL = 20;
const MAX_RSS_GROWTH_MB = 300;

const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

function auditXlsx(): Buffer {
  const strings = Array.from(
    { length: 4000 },
    (_, i) => `${'x'.repeat(4490)}-${String(i).padStart(6, '0')}`,
  );
  const header = Array.from({ length: 30 }, (_, c) => `col${c + 1}`);
  const rows: string[][] = [header];
  for (let r = 0; r < 9000; r++) {
    rows.push(header.map((_, c) => strings[(r * 30 + c) % strings.length]));
  }
  return buildXlsx(rows);
}

const mb = (bytes: number) => Math.round(bytes / 1024 / 1024);

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

describeSlow('Importación: 20 lecturas en paralelo (SEC-046, carga)', () => {
  jest.setTimeout(300_000);
  let app: INestApplication<App>;
  let http: ListeningApp;
  let victim: Clinic;
  const attackers: Clinic[] = [];
  const file = auditXlsx();

  const inspect = (clinic: Clinic) =>
    http
      .post('/api/v1/patient-imports/inspect')
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .attach('file', file, {
        filename: 'auditoria.xlsx',
        contentType:
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });

  /** Lanza las lecturas a la vez, mide el pico de RSS y la latencia de la víctima. */
  async function attack(clinics: Clinic[]) {
    global.gc?.();
    const base = process.memoryUsage().rss;
    let peak = base;
    const sampler = setInterval(() => {
      peak = Math.max(peak, process.memoryUsage().rss);
    }, 20);
    const latencies: number[] = [];
    let attacking = true;
    const victimLoop = (async () => {
      while (attacking) {
        const start = Date.now();
        await http
          .get('/api/v1/patients')
          .set('X-Tenant-Host', victim.host)
          .set('Authorization', `Bearer ${victim.adminToken}`)
          .expect(200);
        latencies.push(Date.now() - start);
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    const start = Date.now();
    const statuses = (
      await Promise.all(clinics.map((clinic) => inspect(clinic)))
    ).map((res) => res.status);
    const durationMs = Date.now() - start;
    attacking = false;
    await victimLoop;
    clearInterval(sampler);
    const counts: Record<number, number> = {};
    for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
    const result = {
      statuses: counts,
      durationMs,
      rssBaseMb: mb(base),
      rssPeakMb: mb(peak),
      rssGrowthMb: mb(peak - base),
      victimP50Ms: percentile(latencies, 0.5),
      victimMaxMs: Math.max(...latencies),
    };
    process.stdout.write(`SEC-046 carga: ${JSON.stringify(result)}\n`);
    return result;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    http = await listenOnEphemeralPort(app, PARALLEL + 2);
    await resetDatabase(raw);
    victim = await registerClinic(app, 'sec046-victima');
    for (let i = 0; i < PARALLEL; i++) {
      attackers.push(await registerClinic(app, `sec046-carga-${i}`));
    }
    // Calentar: una lectura sola, que además confirma que el fichero es válido.
    expect((await inspect(attackers[0])).status).toBe(200);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await http.close();
    await raw.$disconnect();
  });

  it(`una clínica con ${PARALLEL} lecturas a la vez: el pico de RSS crece menos de ${MAX_RSS_GROWTH_MB} MB`, async () => {
    const result = await attack(
      Array.from({ length: PARALLEL }, () => attackers[0]),
    );
    expect(result.rssGrowthMb).toBeLessThan(MAX_RSS_GROWTH_MB);
  });

  it(`${PARALLEL} clínicas con una lectura cada una a la vez: el pico de RSS crece menos de ${MAX_RSS_GROWTH_MB} MB`, async () => {
    const result = await attack(attackers);
    expect(result.rssGrowthMb).toBeLessThan(MAX_RSS_GROWTH_MB);
  });
});
