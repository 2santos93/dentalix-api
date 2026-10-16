import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-120, capa DB del odontograma fase 2: patient_dentition_events (RLS,
// append-only, CHECKs) y tooth_records (append-only, anulación con motivo y
// única). Cada caso escribe POR LA MISMA RUTA que la app (runWithTenant, rol
// dentalix_app, sujeto a RLS) o con una conexión directa como dentalix_app;
// `raw` (DIRECT_URL, superusuario) solo siembra y limpia.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const APPEND_ONLY = /append-only/;
const FK_VIOLATION = { code: 'P2003' };
const UNIQUE_VIOLATION = { code: 'P2002' };

interface Seeded {
  tenantId: string;
  patientId: string;
  otherPatientId: string;
  recordId: string;
  otherPatientRecordId: string;
  eventId: string;
}

let authorId: string;

async function seedClinic(subdomain: string): Promise<Seeded> {
  const { id: tenantId } = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const patient = await raw.patient.create({
    data: { tenantId, firstName: 'Niña', lastName: subdomain },
  });
  const other = await raw.patient.create({
    data: { tenantId, firstName: 'Otro', lastName: subdomain },
  });
  return prisma.runWithTenant(tenantId, async (tx) => {
    const record = await tx.toothRecord.create({
      data: {
        tenantId,
        patientId: patient.id,
        toothNumber: '64',
        kind: 'DIAGNOSIS',
        performedById: authorId,
      },
    });
    const otherRecord = await tx.toothRecord.create({
      data: {
        tenantId,
        patientId: other.id,
        toothNumber: '11',
        kind: 'DIAGNOSIS',
        performedById: authorId,
      },
    });
    const event = await tx.patientDentitionEvent.create({
      data: {
        tenantId,
        patientId: patient.id,
        position: '15',
        dentition: 'PERMANENT',
        reason: 'EXFOLIATION',
        performedById: authorId,
      },
    });
    return {
      tenantId,
      patientId: patient.id,
      otherPatientId: other.id,
      recordId: record.id,
      otherPatientRecordId: otherRecord.id,
      eventId: event.id,
    };
  });
}

async function cleanup(tenantIds: string[]): Promise<void> {
  const where = { tenantId: { in: tenantIds } };
  // Superusuario: el trigger deja la purga administrativa (y la FK de la
  // anulación es NO ACTION: registro y anulación caen en el mismo DELETE).
  await raw.patientDentitionEvent.deleteMany({ where });
  await raw.toothRecord.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

describe('odontograma fase 2 en la BD (DX-120, int)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await prisma.onModuleInit();
    authorId = (
      await raw.user.create({
        data: {
          email: 'dx120-int-autor@example.com',
          passwordHash: 'x',
          fullName: 'Dra. Odontopediatra',
        },
      })
    ).id;
    a = await seedClinic('dx120-int-a');
    b = await seedClinic('dx120-int-b');
  });

  afterAll(async () => {
    await cleanup([a.tenantId, b.tenantId]);
    await raw.user.delete({ where: { id: authorId } });
    await raw.$disconnect();
    await appRole.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  function voidData(
    extra: Partial<Prisma.ToothRecordUncheckedCreateInput> = {},
  ): Prisma.ToothRecordUncheckedCreateInput {
    return {
      tenantId: a.tenantId,
      patientId: a.patientId,
      toothNumber: '64',
      kind: 'DIAGNOSIS',
      performedById: authorId,
      voidsRecordId: a.recordId,
      voidReason: 'Registrado en el diente equivocado',
      ...extra,
    };
  }

  function eventData(
    extra: Partial<Prisma.PatientDentitionEventUncheckedCreateInput> = {},
  ): Prisma.PatientDentitionEventUncheckedCreateInput {
    return {
      tenantId: a.tenantId,
      patientId: a.patientId,
      position: '11',
      dentition: 'MIXED',
      reason: 'MANUAL',
      performedById: authorId,
      ...extra,
    };
  }

  /** SQL directo como dentalix_app, con el GUC de tenant como lo fija la app. */
  function asAppRole(sql: string, id: string) {
    return appRole.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
      return tx.$executeRawUnsafe(sql, id);
    });
  }

  describe.each([
    ['tooth_records', 'notes', () => a.recordId],
    ['patient_dentition_events', 'position', () => a.eventId],
  ])('%s es append-only', (table, column, id) => {
    it('rechaza el UPDATE por SQL como rol de la app', async () => {
      await expect(
        asAppRole(
          `UPDATE "${table}" SET "${column}" = '21' WHERE "id" = $1::uuid`,
          id(),
        ),
      ).rejects.toThrow(APPEND_ONLY);
    });

    it('rechaza el DELETE por SQL como rol de la app', async () => {
      await expect(
        asAppRole(`DELETE FROM "${table}" WHERE "id" = $1::uuid`, id()),
      ).rejects.toThrow(APPEND_ONLY);
    });

    it('rechaza el DELETE aunque una tabla temporal suplante pg_roles (SEC-032)', async () => {
      await expect(
        appRole.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_tenant', ${a.tenantId}, true)`;
          await tx.$executeRawUnsafe(
            'CREATE TEMP TABLE pg_roles (rolname name, rolsuper boolean) ON COMMIT DROP',
          );
          await tx.$executeRawUnsafe(
            'INSERT INTO pg_roles VALUES (current_user, true)',
          );
          return tx.$executeRawUnsafe(
            `DELETE FROM "${table}" WHERE "id" = $1::uuid`,
            id(),
          );
        }),
      ).rejects.toThrow(APPEND_ONLY);
    });

    it('rechaza el UPDATE incluso al superusuario', async () => {
      await expect(
        raw.$executeRawUnsafe(
          `UPDATE "${table}" SET "createdAt" = now() - interval '1 day' WHERE "id" = $1::uuid`,
          id(),
        ),
      ).rejects.toThrow(APPEND_ONLY);
    });

    it('rechaza el TRUNCATE del rol de la app', async () => {
      await expect(
        appRole.$executeRawUnsafe(`TRUNCATE "${table}" CASCADE`),
      ).rejects.toThrow();
    });
  });

  it('Prisma tampoco puede editar ni retirar en blando un registro del odontograma', async () => {
    await expect(
      asA((tx) =>
        tx.toothRecord.update({
          where: { id: a.recordId },
          data: { deletedAt: new Date() },
        }),
      ),
    ).rejects.toThrow(APPEND_ONLY);
  });

  describe('patient_dentition_events: RLS y FK compuesta', () => {
    it('la clínica B no ve los eventos de A', async () => {
      const seen = await prisma.runWithTenant(b.tenantId, (tx) =>
        tx.patientDentitionEvent.findMany(),
      );
      expect(seen.map((e) => e.tenantId)).toEqual([b.tenantId]);
    });

    it('B no puede escribir con el tenantId de A (WITH CHECK)', async () => {
      await expect(
        prisma.runWithTenant(b.tenantId, (tx) =>
          tx.patientDentitionEvent.create({ data: eventData() }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('no admite el paciente de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.patientDentitionEvent.create({
            data: eventData({ patientId: b.patientId }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('la fecha de grabación la pone la BD', async () => {
      const before = Date.now();
      const row = await asA((tx) =>
        tx.patientDentitionEvent.create({
          data: eventData({ createdAt: new Date('2001-01-01T00:00:00Z') }),
        }),
      );
      expect(row.createdAt.getTime()).toBeGreaterThanOrEqual(before - 60_000);
    });
  });

  describe('patient_dentition_events: CHECKs', () => {
    it('la posición es un código FDI permanente', async () => {
      await expect(
        asA((tx) =>
          tx.patientDentitionEvent.create({
            data: eventData({ position: '55' }),
          }),
        ),
      ).rejects.toThrow(/patient_dentition_events_position_fdi/);
    });

    it('un molar no puede estar en mixta', async () => {
      await expect(
        asA((tx) =>
          tx.patientDentitionEvent.create({
            data: eventData({ position: '16' }),
          }),
        ),
      ).rejects.toThrow(/patient_dentition_events_mixed_has_primary/);
    });

    it('exfoliar deja la posición en permanente', async () => {
      await expect(
        asA((tx) =>
          tx.patientDentitionEvent.create({
            data: eventData({ reason: 'EXFOLIATION', dentition: 'PRIMARY' }),
          }),
        ),
      ).rejects.toThrow(
        /patient_dentition_events_exfoliation_leaves_permanent/,
      );
    });
  });

  describe('tooth_records: anulación', () => {
    it('el origen por defecto es THIS_CLINIC', async () => {
      const row = await raw.toothRecord.findUniqueOrThrow({
        where: { id: a.recordId },
      });
      expect(row.origin).toBe('THIS_CLINIC');
    });

    it('CHECK: una anulación sin motivo (o con solo espacios) se rechaza', async () => {
      for (const voidReason of [null, '', '   ']) {
        await expect(
          asA((tx) =>
            tx.toothRecord.create({ data: voidData({ voidReason }) }),
          ),
        ).rejects.toThrow(/tooth_records_void_reason_required/);
      }
    });

    it('CHECK: un motivo solo va en una anulación', async () => {
      await expect(
        asA((tx) =>
          tx.toothRecord.create({
            data: voidData({ voidsRecordId: null }),
          }),
        ),
      ).rejects.toThrow(/tooth_records_void_reason_only_on_void/);
    });

    it('FK compuesta: no se anula el registro de otro paciente ni el de otra clínica', async () => {
      await expect(
        asA((tx) =>
          tx.toothRecord.create({
            data: voidData({ voidsRecordId: a.otherPatientRecordId }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
      await expect(
        asA((tx) =>
          tx.toothRecord.create({
            data: voidData({ voidsRecordId: b.recordId }),
          }),
        ),
      ).rejects.toMatchObject(FK_VIOLATION);
    });

    it('índice único: un registro se anula una sola vez, y el original no cambia', async () => {
      const original = await raw.toothRecord.findUniqueOrThrow({
        where: { id: a.recordId },
      });
      await asA((tx) => tx.toothRecord.create({ data: voidData() }));
      await expect(
        asA((tx) =>
          tx.toothRecord.create({
            data: voidData({ voidReason: 'Otra vez' }),
          }),
        ),
      ).rejects.toMatchObject(UNIQUE_VIOLATION);
      expect(
        await raw.toothRecord.findUniqueOrThrow({ where: { id: a.recordId } }),
      ).toEqual(original);
      expect(
        await raw.toothRecord.count({ where: { voidsRecordId: a.recordId } }),
      ).toBe(1);
    });
  });
});
