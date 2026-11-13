import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { PRESCRIPTION_VERIFICATION_ALPHABET } from '../src/modules/prescriptions/domain/prescription-verification-code';

// DX-467 contra Postgres: el código de verificación de la receta. La función
// SQL (DEFAULT de la columna y relleno) sortea con el mismo alfabeto que la
// app; la columna es NOT NULL, única en todo Dentalix, con forma fija e
// inmutable (trigger de la receta). El relleno da código a TODA receta
// anterior, clínica a clínica, desactivando el trigger solo alrededor de su
// UPDATE y sin tocar ninguna otra columna.

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const MIGRATIONS = join(__dirname, '../prisma/migrations');
const read = (name: string) =>
  readFileSync(join(MIGRATIONS, name, 'migration.sql'), 'utf8');
const ADD = read('20261216090000_dx467_prescription_verification_code');
const BACKFILL = read(
  '20261216090100_dx467_prescription_verification_code_backfill',
);
const VALIDATE = read(
  '20261216090200_dx467_prescription_verification_code_validate',
);
const SHAPE = /^[2-9A-HJKMNP-Z]{12}$/;

/**
 * Las sentencias de una migración, sin comentarios ni BEGIN/COMMIT (el test
 * la corre dentro de su propia transacción). Los cuerpos `$$ … $$` van
 * enteros aunque lleven `;` (molde de clinic-logo-freeze.int-spec.ts).
 */
function statements(sql: string): string[] {
  const parts = sql.replace(/--[^\n]*/g, '').split('$$');
  const out: string[] = [];
  let current = '';
  parts.forEach((part, i) => {
    if (i % 2 === 1) {
      current += `$$${part}$$`;
      return;
    }
    const pieces = part.split(';');
    pieces.forEach((piece, j) => {
      current += piece;
      if (j < pieces.length - 1) {
        out.push(current.trim());
        current = '';
      }
    });
  });
  if (current.trim()) out.push(current.trim());
  return out.filter((s) => s && !/^(BEGIN|COMMIT)$/i.test(s));
}

describe('DX-467: código de verificación de la receta — migraciones (Postgres)', () => {
  const ids: string[] = [];
  let clinicOne: Awaited<ReturnType<typeof clinic>>;

  async function clinic(tag: string) {
    const tenant = await raw.tenant.create({
      data: { name: `DX467 ${tag}`, subdomain: `dx467-${tag}` },
    });
    const user = await raw.user.create({
      data: {
        email: `dx467-${tag}@example.com`,
        fullName: 'Dra. QA',
        passwordHash: 'unused',
      },
    });
    const patient = await raw.patient.create({
      data: { tenantId: tenant.id, firstName: 'Ana', lastName: tag },
    });
    const location = await raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: tenant.id,
        name: 'Sede Caracas',
      }),
    });
    const data = (
      extra: Partial<Prisma.PrescriptionUncheckedCreateInput> = {},
    ) => ({
      tenantId: tenant.id,
      locationId: location.id,
      patientId: patient.id,
      professionalId: user.id,
      singleFormat: true,
      printQuantityInWords: false,
      issuedAt: new Date('2026-11-10T12:00:00.000Z'),
      dispensationDate: new Date('2026-11-10T00:00:00.000Z'),
      validUntil: new Date('2026-12-10T00:00:00.000Z'),
      patientName: `Ana ${tag}`,
      professionalName: 'Dra. QA',
      professionalLicense: 'MPPS-1',
      clinicName: `DX467 ${tag}`,
      locationName: 'Sede Caracas',
      contentHash: 'b'.repeat(64),
      ...extra,
    });
    return {
      tenantId: tenant.id,
      data,
      // Sin nombrar la columna, como una réplica anterior: el DEFAULT.
      prescription: async () => {
        const row = await raw.prescription.create({ data: data() });
        ids.push(row.id);
        return row;
      },
    };
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    clinicOne = await clinic('uno');
    const two = await clinic('dos');
    for (let i = 0; i < 3; i++) await clinicOne.prescription();
    for (let i = 0; i < 2; i++) await two.prescription();
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('el DEFAULT da a una receta insertada sin código uno con la forma pública', async () => {
    const rows = await raw.prescription.findMany({
      where: { id: { in: ids } },
      select: { verificationCode: true },
    });
    expect(rows).toHaveLength(5);
    for (const { verificationCode } of rows)
      expect(verificationCode).toMatch(SHAPE);
    expect(new Set(rows.map((r) => r.verificationCode)).size).toBe(5);
  });

  it('la función SQL usa exactamente el alfabeto de la app (sin 0/O, 1/I/L)', async () => {
    const [{ codes }] = await raw.$queryRaw<{ codes: string[] }[]>`
      SELECT array_agg(public.dx_prescription_verification_code()) AS codes
        FROM generate_series(1, 600)`;
    const symbols = new Set(codes.join(''));
    for (const code of codes) expect(code).toMatch(SHAPE);
    expect([...symbols].sort().join('')).toBe(
      [...PRESCRIPTION_VERIFICATION_ALPHABET].sort().join(''),
    );
    expect(new Set(codes).size).toBe(600);
  });

  it('único en todo Dentalix, con forma fija y NOT NULL', async () => {
    const [first] = await raw.prescription.findMany({
      where: { id: { in: ids } },
      take: 1,
    });
    await expect(
      raw.prescription.create({
        data: clinicOne.data({ verificationCode: first.verificationCode }),
      }),
    ).rejects.toThrow(/verificationCode|prescriptions_verification_code_key/);
    for (const bad of [
      'ABCDEFGHJKM0',
      'ABCDEFGHJKMI',
      'abcdefghjkmn',
      'ABCDEFGHJKM',
    ]) {
      await expect(
        raw.prescription.create({
          data: clinicOne.data({ verificationCode: bad }),
        }),
      ).rejects.toThrow(/prescriptions_verification_code_check/);
    }
    const [{ notnull }] = await raw.$queryRaw<{ notnull: boolean }[]>`
      SELECT attnotnull AS notnull FROM pg_attribute
       WHERE attrelid = 'public.prescriptions'::regclass AND attname = 'verificationCode'`;
    expect(notnull).toBe(true);
  });

  it('inmutable: el trigger de la receta rechaza cambiar el código', async () => {
    await expect(
      raw.$executeRaw`UPDATE prescriptions SET "verificationCode" = 'ABCDEFGHJKMN' WHERE id = ${ids[0]}::uuid`,
    ).rejects.toThrow(/inmutable/);
  });

  it('el relleno da código a cada receta anterior, solo cambia esa columna y deja el trigger activo', async () => {
    const rowsOf = (tx: Prisma.TransactionClient) =>
      tx.$queryRaw<{ id: string; row: Record<string, unknown> }[]>`
        SELECT id::text, to_jsonb(p) - 'verificationCode' AS row
          FROM prescriptions p ORDER BY 1`;
    const before = await rowsOf(raw);
    await expect(
      raw.$transaction(
        async (tx) => {
          // Estado anterior a la primera migración: sin la columna ni la función.
          await tx.$executeRawUnsafe(
            'ALTER TABLE prescriptions DROP COLUMN "verificationCode"',
          );
          await tx.$executeRawUnsafe(
            'DROP FUNCTION public."dx_prescription_verification_code"()',
          );
          for (const sql of [ADD, BACKFILL, VALIDATE])
            for (const statement of statements(sql))
              await tx.$executeRawUnsafe(statement);

          const codes = await tx.$queryRaw<{ code: string | null }[]>`
            SELECT "verificationCode" AS code FROM prescriptions`;
          expect(codes).toHaveLength(before.length);
          for (const { code } of codes) expect(code).toMatch(SHAPE);
          expect(new Set(codes.map((c) => c.code)).size).toBe(codes.length);
          expect(await rowsOf(tx)).toEqual(before);

          const [trigger] = await tx.$queryRaw<{ tgenabled: string }[]>`
            SELECT tgenabled::text FROM pg_trigger WHERE tgname = 'prescriptions_immutable'`;
          expect(trigger.tgenabled).toBe('O');
          const [{ tenant }] = await tx.$queryRaw<{ tenant: string | null }[]>`
            SELECT current_setting('app.current_tenant', true) AS tenant`;
          expect(tenant ?? '').toBe('');
          const [check] = await tx.$queryRaw<{ convalidated: boolean }[]>`
            SELECT convalidated FROM pg_constraint
             WHERE conname = 'prescriptions_verification_code_check'`;
          expect(check.convalidated).toBe(true);
          const [index] = await tx.$queryRaw<{ indexdef: string }[]>`
            SELECT indexdef FROM pg_indexes
             WHERE indexname = 'prescriptions_verification_code_key'`;
          expect(index.indexdef).toMatch(/UNIQUE INDEX/);

          await tx.$executeRawUnsafe('SAVEPOINT dx467');
          await expect(
            tx.$executeRawUnsafe(
              `UPDATE prescriptions SET "verificationCode" = 'ABCDEFGHJKMN' WHERE id = $1::uuid`,
              ids[0],
            ),
          ).rejects.toThrow(/inmutable/);
          await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT dx467');
          throw new Error('ROLLBACK_QA');
        },
        { timeout: 30000 },
      ),
    ).rejects.toThrow('ROLLBACK_QA');
  });

  it('el relleno desactiva SOLO prescriptions_immutable, solo alrededor del UPDATE, dentro de BEGIN … COMMIT, y solo escribe "verificationCode"', () => {
    const body = BACKFILL.replace(/--[^\n]*/g, '');
    const order = [
      /^BEGIN;$/m,
      /SET LOCAL lock_timeout = '5s';/,
      /ALTER TABLE "prescriptions" DISABLE TRIGGER "prescriptions_immutable";/,
      /^DO \$\$$/m,
      /^\$\$;$/m,
      /ALTER TABLE "prescriptions" ENABLE TRIGGER "prescriptions_immutable";/,
      /^COMMIT;$/m,
    ].map((re) => body.search(re));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(body.match(/DISABLE TRIGGER/g)).toHaveLength(1);
    expect(body.match(/ENABLE TRIGGER/g)).toHaveLength(1);
    expect(body).not.toMatch(
      /FORCE ROW LEVEL SECURITY|TRIGGER ALL|TRIGGER USER/,
    );
    const sets = [...body.matchAll(/\bSET\s+("?\w+"?)\s*=/g)].map((m) => m[1]);
    expect(sets).toEqual(['"verificationCode"']);
  });
});
