import { execFileSync } from 'node:child_process';
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { normalizeReference } from '../src/modules/payment-methods/domain/payment-method-rules';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-395, capa DB: la migración 20261103130000 repite el enlace de los abonos
// que las réplicas anteriores a DX-377 crearon sin medio durante el
// despliegue y quita puntos y guiones de las referencias ya normalizadas,
// clínica por clínica, por lotes e idempotente. Sobre una BD desechable.
const ROOT = join(__dirname, '..');
const MIGRATION = '20261103130000_dx395_payments_relink_reference';

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  planId: string;
  methods: Record<string, string>;
}

async function seedClinic(
  db: PrismaClient,
  subdomain: string,
): Promise<Seeded> {
  // SQL y no `db.tenant.create`: la BD está migrada solo hasta esta migración y
  // el cliente insertaría columnas de tenant posteriores (p. ej. DX-253).
  const [tenant] = await db.$queryRaw<{ id: string }[]>`
    INSERT INTO "tenants" ("id", "name", "subdomain", "updatedAt")
    VALUES (gen_random_uuid(), ${subdomain}, ${subdomain}, now())
    RETURNING "id"`;
  const location = await db.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede',
    }),
  });
  const patient = await db.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: subdomain },
  });
  const plan = await db.treatmentPlan.create({
    data: {
      tenantId: tenant.id,
      patientId: patient.id,
      currency: 'COP',
      status: 'ACCEPTED',
    },
  });
  // Los 4 medios iniciales (como el alta) y uno propio.
  const methods: Record<string, string> = {};
  for (const [name, kind, legacyMethod] of [
    ['Efectivo', 'CASH', 'CASH'],
    ['Tarjeta', 'CARD', 'CARD'],
    ['Transferencia', 'TRANSFER', 'TRANSFER'],
    ['Otro', 'OTHER', 'OTHER'],
    ['Pago móvil', 'DIGITAL', null],
  ] as const) {
    const row = await db.clinicPaymentMethod.create({
      data: { tenantId: tenant.id, name, kind, legacyMethod },
    });
    methods[name] = row.id;
  }
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    planId: plan.id,
    methods,
  };
}

/** Un abono por SQL, como lo escribiría una réplica (vieja o nueva). */
async function insertPayment(
  db: PrismaClient,
  c: Seeded,
  method: string | null,
  extra: {
    paymentMethodId?: string;
    reference?: string;
    referenceNormalized?: string;
  } = {},
): Promise<string> {
  const [{ id }] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId",
       "patientId", "amount", "currency", "paidAt", "method", "updatedAt",
       "paymentMethodId", "reference", "referenceNormalized")
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, $4::uuid, 1000,
       'COP', now(), $5::"PaymentMethod", now(), $6::uuid, $7, $8)
     RETURNING "id"`,
    c.tenantId,
    c.locationId,
    c.planId,
    c.patientId,
    method,
    extra.paymentMethodId ?? null,
    extra.reference ?? null,
    extra.referenceNormalized ?? null,
  );
  return id;
}

describe('DX-395 · relleno repetido y referencias renormalizadas (int, BD desechable)', () => {
  const admin = new PrismaClient<Prisma.PrismaClientOptions>({
    datasources: { db: { url: process.env.DIRECT_URL } },
  });
  let db: string;
  let dir: string;
  let target: PrismaClient;
  let a: Seeded;
  let b: Seeded;
  const ids: Record<string, string> = {};

  const urlFor = (name: string): string => {
    const url = new URL(process.env.DIRECT_URL as string);
    url.pathname = `/${name}`;
    return url.toString();
  };
  const deploy = (url: string): void => {
    execFileSync(
      join(ROOT, 'node_modules/.bin/prisma'),
      ['migrate', 'deploy', '--schema', join(dir, 'schema.prisma')],
      {
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: url, DIRECT_URL: url },
        stdio: 'pipe',
      },
    );
  };
  const snapshot = async () =>
    target.payment.findMany({
      select: {
        id: true,
        method: true,
        paymentMethodId: true,
        reference: true,
        referenceNormalized: true,
        updatedAt: true,
      },
      orderBy: { id: 'asc' },
    });

  beforeAll(async () => {
    db = `dx395_relink_${process.pid}_${Date.now()}`;
    await admin.$executeRawUnsafe(`CREATE DATABASE "${db}"`);
    dir = mkdtempSync(join(tmpdir(), 'dx395-'));
    cpSync(join(ROOT, 'prisma/schema.prisma'), join(dir, 'schema.prisma'));
    cpSync(
      join(ROOT, 'prisma/migrations/migration_lock.toml'),
      join(dir, 'migrations/migration_lock.toml'),
    );
    const all = readdirSync(join(ROOT, 'prisma/migrations')).filter(
      (n) => !n.endsWith('.toml'),
    );
    const copy = (name: string): void =>
      cpSync(
        join(ROOT, 'prisma/migrations', name),
        join(dir, 'migrations', name),
        { recursive: true },
      );
    for (const name of all.filter((n) => n < MIGRATION)) copy(name);
    deploy(urlFor(db));
    target = new PrismaClient<Prisma.PrismaClientOptions>({
      datasources: { db: { url: urlFor(db) } },
    });
    a = await seedClinic(target, 'dx395-old-a');
    b = await seedClinic(target, 'dx395-old-b');
    // Réplicas anteriores a DX-377 durante el despliegue: sin medio.
    ids.cashA = await insertPayment(target, a, 'CASH');
    ids.transferB = await insertPayment(target, b, 'TRANSFER');
    ids.noneA = await insertPayment(target, a, null);
    // Referencias guardadas con la normalización de DX-377.
    ids.dashA = await insertPayment(target, a, 'TRANSFER', {
      paymentMethodId: a.methods['Pago móvil'],
      reference: '123-456',
      referenceNormalized: '123-456',
    });
    ids.dotsA = await insertPayment(target, a, 'TRANSFER', {
      paymentMethodId: a.methods['Pago móvil'],
      reference: 'ab.12–3',
      referenceNormalized: 'AB.12–3',
    });
    ids.onlySeparatorsA = await insertPayment(target, a, 'TRANSFER', {
      paymentMethodId: a.methods['Pago móvil'],
      reference: '--',
      referenceNormalized: '--',
    });
    ids.slashB = await insertPayment(target, b, 'TRANSFER', {
      paymentMethodId: b.methods['Pago móvil'],
      reference: '12/34',
      referenceNormalized: '12/34',
    });
    copy(MIGRATION);
    deploy(urlFor(db));
  }, 300_000);

  afterAll(async () => {
    await target?.$disconnect();
    await admin.$executeRawUnsafe(
      `DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`,
    );
    rmSync(dir, { recursive: true, force: true });
    await admin.$disconnect();
  }, 60_000);

  it('enlaza los abonos sin medio al medio inicial de su método en SU clínica', async () => {
    const rows = new Map((await snapshot()).map((p) => [p.id, p]));
    expect(rows.get(ids.cashA)).toMatchObject({
      method: 'CASH',
      paymentMethodId: a.methods.Efectivo,
    });
    expect(rows.get(ids.transferB)).toMatchObject({
      method: 'TRANSFER',
      paymentMethodId: b.methods.Transferencia,
    });
    // Sin método se queda sin medio.
    expect(rows.get(ids.noneA)).toMatchObject({
      method: null,
      paymentMethodId: null,
    });
    // Un abono que ya tenía medio lo conserva.
    expect(rows.get(ids.dashA)?.paymentMethodId).toBe(a.methods['Pago móvil']);
  });

  it('quita puntos y guiones de la referencia normalizada, igual que la API', async () => {
    const rows = new Map((await snapshot()).map((p) => [p.id, p]));
    expect(rows.get(ids.dashA)).toMatchObject({
      reference: '123-456',
      referenceNormalized: '123456',
    });
    expect(rows.get(ids.dashA)?.referenceNormalized).toBe(
      normalizeReference('123 456'),
    );
    expect(rows.get(ids.dotsA)).toMatchObject({
      reference: 'ab.12–3',
      referenceNormalized: normalizeReference('ab.12–3'),
    });
    // Otros separadores siguen contando; solo separadores no se toca (CHECK).
    expect(rows.get(ids.slashB)?.referenceNormalized).toBe('12/34');
    expect(rows.get(ids.onlySeparatorsA)?.referenceNormalized).toBe('--');
  });

  it('es idempotente: repetirla no cambia ninguna fila', async () => {
    const before = await snapshot();
    const sql = readFileSync(
      join(ROOT, 'prisma/migrations', MIGRATION, 'migration.sql'),
      'utf8',
    );
    await target.$executeRawUnsafe(sql);
    expect(await snapshot()).toEqual(before);
  });
});
