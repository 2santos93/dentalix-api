import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-058-bis (DB-016): FK "tenantId" -> tenants(id) en patients, locations y
// location_schedules, las tres raíces sin FK directa a tenants (el resto de
// tablas de clínica cuelga de ellas por FK compuestas). La comprobación previa
// de la migración se ejecuta TAL CUAL está en el .sql (no se copia), dentro de
// transacciones que acaban en ROLLBACK.
const MIGRATIONS = join(__dirname, '../prisma/migrations');
const ADD = readFileSync(
  join(MIGRATIONS, '20270207100000_dx058bis_tenant_fk_roots/migration.sql'),
  'utf8',
);
const VALIDATE = readFileSync(
  join(
    MIGRATIONS,
    '20270207100100_dx058bis_tenant_fk_roots_validate/migration.sql',
  ),
  'utf8',
);
const ROW_SECURITY_OFF = 'SET LOCAL row_security = off;';
const sqlOnly = (sql: string) =>
  sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
// DX-484: el alta de un paciente pasa antes por el contador de su clínica
// (trigger BEFORE INSERT a patient_code_counters, con su propia FK a tenants).
// Para ver la FK de patients sola, el trigger se apaga (y el código se da a
// mano) dentro de la transacción que acaba en ROLLBACK.
const CODE_TRIGGER_OFF =
  'ALTER TABLE "patients" DISABLE TRIGGER "patients_code_assign"';
const PREFLIGHT = /^DO \$\$[\s\S]*?^END \$\$;$/m.exec(ADD)?.[0] ?? '';
const CONSTRAINTS = [
  'patients_tenantId_fkey',
  'locations_tenantId_fkey',
  'location_schedules_tenantId_fkey',
];

// Owner (DIRECT_URL): el rol con el que corren las migraciones.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
// Rol de la app (DATABASE_URL): sin BYPASSRLS, sujeto a la RLS FORCE.
const app = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const SUBDOMAIN = 'dx058bis-fk-raices';

class Rollback extends Error {}

describe('FK tenantId -> tenants en las raíces (DX-058-bis, int)', () => {
  let tenantId: string;

  beforeAll(async () => {
    tenantId = (
      await owner.tenant.create({
        data: { name: 'Clínica Caracas FK', subdomain: SUBDOMAIN },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    const ids = (
      await owner.tenant.findMany({
        where: { subdomain: SUBDOMAIN },
        select: { id: true },
      })
    ).map((t) => t.id);
    await owner.locationSchedule.deleteMany({
      where: { tenantId: { in: ids } },
    });
    await owner.location.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.patient.deleteMany({ where: { tenantId: { in: ids } } });
    await owner.tenant.deleteMany({ where: { id: { in: ids } } });
    await owner.$disconnect();
    await app.$disconnect();
  });

  it('las tres FK existen, validadas, con ON DELETE RESTRICT', async () => {
    const rows = await owner.$queryRaw<
      { conname: string; convalidated: boolean; confdeltype: string }[]
    >`
      SELECT conname, convalidated, confdeltype::text AS confdeltype
        FROM pg_constraint
       WHERE contype = 'f'
         AND confrelid = 'public.tenants'::regclass
         AND conname = ANY(${CONSTRAINTS})
       ORDER BY conname`;
    expect(rows).toEqual(
      [...CONSTRAINTS].sort().map((conname) => ({
        conname,
        convalidated: true,
        confdeltype: 'r',
      })),
    );
  });

  it('la migración añade NOT VALID y valida en otra; row_security off antes de la comprobación', () => {
    expect(PREFLIGHT).toContain('RAISE EXCEPTION');
    const rowSecurityAt = ADD.indexOf(ROW_SECURITY_OFF);
    expect(rowSecurityAt).toBeGreaterThanOrEqual(0);
    expect(ADD.indexOf(PREFLIGHT)).toBeGreaterThan(rowSecurityAt);
    for (const name of CONSTRAINTS) {
      expect(ADD).toMatch(
        new RegExp(`ADD CONSTRAINT "${name}"[\\s\\S]*?NOT VALID;`),
      );
      expect(ADD.indexOf(`ADD CONSTRAINT "${name}"`)).toBeGreaterThan(
        ADD.indexOf(PREFLIGHT),
      );
      expect(sqlOnly(ADD)).not.toContain('VALIDATE CONSTRAINT');
      expect(VALIDATE).toContain(`VALIDATE CONSTRAINT "${name}"`);
    }
  });

  describe('no se crea nada de una clínica que no existe', () => {
    const ghost = randomUUID();

    it('paciente (también sin el contador de DX-484 delante)', async () => {
      await expect(
        owner.patient.create({
          data: { tenantId: ghost, firstName: 'Ana', lastName: 'Pérez' },
        }),
      ).rejects.toThrow(/Foreign key constraint/);

      const bare = owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(CODE_TRIGGER_OFF);
        await tx.patient.create({
          data: {
            tenantId: ghost,
            firstName: 'Ana',
            lastName: 'Pérez',
            patientCode: 1,
          },
        });
        throw new Rollback('el alta debía fallar');
      });
      await expect(bare).rejects.toThrow(/patients_tenantId_fkey/);
    });

    it('ni mover un paciente a una clínica que no existe', async () => {
      const patient = await owner.patient.create({
        data: { tenantId, firstName: 'José', lastName: 'Mora' },
        select: { id: true },
      });
      await expect(
        owner.patient.update({
          where: { id: patient.id },
          data: { tenantId: ghost },
        }),
      ).rejects.toThrow(/patients_tenantId_fkey/);
    });

    it('sede', async () => {
      await expect(
        owner.location.create({
          data: locationData(REGIONAL_CARACAS_FIXTURE, {
            tenantId: ghost,
            name: 'Sede fantasma',
          }),
        }),
      ).rejects.toThrow(/locations_tenantId_fkey/);
    });

    it('horario de sede', async () => {
      await expect(
        owner.locationSchedule.create({
          data: { tenantId: ghost, locationId: randomUUID() },
        }),
      ).rejects.toThrow(/location_schedules_tenantId_fkey/);
    });

    it('tampoco desde la app, con la clínica inexistente en el contexto (la RLS la deja pasar; la FK no)', async () => {
      const asApp = app.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.current_tenant', ${ghost}, true)`;
        await tx.location.create({
          data: locationData(REGIONAL_CARACAS_FIXTURE, {
            tenantId: ghost,
            name: 'Sede fantasma',
          }),
        });
      });
      await expect(asApp).rejects.toThrow(/locations_tenantId_fkey/);
    });

    it('control: en una clínica que existe, sí', async () => {
      const location = await owner.location.create({
        data: locationData(REGIONAL_CARACAS_FIXTURE, {
          tenantId,
          name: 'Sede Chacao',
        }),
        select: { id: true },
      });
      await owner.locationSchedule.create({
        data: { tenantId, locationId: location.id },
      });
      await owner.patient.create({
        data: { tenantId, firstName: 'Ana', lastName: 'Pérez' },
      });
    });
  });

  it('RESTRICT: no se borra una clínica que aún tiene sedes o pacientes', async () => {
    const other = await owner.tenant.create({
      data: { name: 'Clínica Valencia FK', subdomain: `${SUBDOMAIN}-b` },
      select: { id: true },
    });
    await owner.patient.create({
      data: { tenantId: other.id, firstName: 'Rosa', lastName: 'Díaz' },
    });
    await expect(
      owner.tenant.delete({ where: { id: other.id } }),
    ).rejects.toThrow(/patients_tenantId_fkey/);

    await owner.patient.deleteMany({ where: { tenantId: other.id } });
    await owner.tenant.delete({ where: { id: other.id } });
  });

  describe('comprobación previa de la migración', () => {
    it('con datos coherentes, pasa', async () => {
      await owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(ROW_SECURITY_OFF);
        await tx.$executeRawUnsafe(PREFLIGHT);
      });
    });

    it('con huérfanas, aborta con RAISE y el desglose por tabla', async () => {
      const ghost = randomUUID();
      const orphans = owner.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(ROW_SECURITY_OFF);
        for (const [table, name] of [
          ['patients', 'patients_tenantId_fkey'],
          ['location_schedules', 'location_schedules_tenantId_fkey'],
        ]) {
          await tx.$executeRawUnsafe(
            `ALTER TABLE "${table}" DROP CONSTRAINT "${name}"`,
          );
        }
        await tx.$executeRawUnsafe(CODE_TRIGGER_OFF);
        await tx.patient.createMany({
          data: [
            {
              tenantId: ghost,
              firstName: 'Ana',
              lastName: 'Huérfana',
              patientCode: 1,
            },
            {
              tenantId: ghost,
              firstName: 'Luis',
              lastName: 'Huérfano',
              patientCode: 2,
            },
          ],
        });
        await tx.locationSchedule.create({
          data: { tenantId: ghost, locationId: randomUUID() },
        });
        await tx.$executeRawUnsafe(PREFLIGHT);
        throw new Rollback('la comprobación debía fallar');
      });

      await expect(orphans).rejects.toThrow(
        /DX-058-bis[\s\S]*patients\.tenantId: 2[\s\S]*location_schedules\.tenantId: 1/,
      );
      await expect(orphans).rejects.not.toThrow(/locations\.tenantId/);
      // ROLLBACK: las FK siguen y las huérfanas no quedaron.
      const fks = await owner.$queryRaw<{ n: bigint }[]>`
        SELECT count(*) AS n FROM pg_constraint WHERE conname = ANY(${CONSTRAINTS})`;
      expect(Number(fks[0].n)).toBe(3);
      expect(await owner.patient.count({ where: { tenantId: ghost } })).toBe(0);
    });

    it('un rol sujeto a RLS no puede contar de menos en silencio: row_security=off lo hace fallar', async () => {
      const asApp = app.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(ROW_SECURITY_OFF);
        await tx.$executeRawUnsafe(PREFLIGHT);
      });
      await expect(asApp).rejects.toThrow(/row-level security/);
    });
  });
});
