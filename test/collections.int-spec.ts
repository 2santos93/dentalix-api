import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaCollectionsRepository } from '../src/modules/collections/infrastructure/prisma-collections.repository';
import { SettlePaymentPromises } from '../src/modules/collections/application/settle-payment-promises';
import { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import { PrismaAuditEventRepository } from '../src/modules/audit/infrastructure/prisma-audit-event.repository';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-150, capa DB: notas de cobranza y compromisos de pago (RLS FORCE, FK
// compuestas, append-only por trigger, un compromiso abierto por paciente) y
// el barrido que los cierra (idempotente, auditado sin usuario). Lo que se
// prueba va por la MISMA ruta que la app (runWithTenant, rol dentalix_app,
// sujeto a RLS); `raw` (DIRECT_URL, superusuario) siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAINS = ['dx150-int-a', 'dx150-int-b'];
const FK_VIOLATION = { code: 'P2003' };
const IMMUTABLE = /inalterable|no admite/;
const BOGOTA = 'America/Bogota';

interface Clinic {
  tenantId: string;
  locationId: string;
  patients: string[];
  planOf: Map<string, string>;
}

let authorId: string;

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const location = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId,
      name: 'Sede',
      country: 'CO',
    }),
  });
  const patients: string[] = [];
  const planOf = new Map<string, string>();
  for (const firstName of ['Ana', 'Beto', 'Caro', 'Dani', 'Eva']) {
    const patient = await raw.patient.create({
      data: { tenantId, firstName, lastName: subdomain },
    });
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId,
        patientId: patient.id,
        status: 'ACCEPTED',
        currency: 'COP',
      },
    });
    patients.push(patient.id);
    planOf.set(patient.id, plan.id);
  }
  return { tenantId, locationId: location.id, patients, planOf };
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  // Superusuario: los triggers append-only dejan la purga administrativa.
  await raw.collectionNote.deleteMany({ where });
  await raw.paymentPromise.deleteMany({ where });
  await raw.paymentReceipt.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patientLedger.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

describe('cobranza: notas y compromisos de pago (int, DX-150)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    await raw.user.deleteMany({ where: { email: 'dx150-int@example.com' } });
    authorId = (
      await raw.user.create({
        data: {
          email: 'dx150-int@example.com',
          passwordHash: 'x',
          fullName: 'Rita Recepción',
        },
      })
    ).id;
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await raw.user.deleteMany({ where: { id: authorId } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asA<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
    return prisma.runWithTenant(a.tenantId, fn);
  }

  const note = (
    clinic: Clinic,
    patientId: string,
    extra: Partial<Prisma.CollectionNoteUncheckedCreateInput> = {},
  ): Prisma.CollectionNoteUncheckedCreateInput => ({
    tenantId: clinic.tenantId,
    patientId,
    locationId: clinic.locationId,
    channel: 'CALL',
    outcome: 'NO_ANSWER',
    text: 'No contesta',
    authorId,
    ...extra,
  });

  const promise = (
    clinic: Clinic,
    patientId: string,
    dueDate: string,
    extra: Partial<Prisma.PaymentPromiseUncheckedCreateInput> = {},
  ): Prisma.PaymentPromiseUncheckedCreateInput => ({
    tenantId: clinic.tenantId,
    patientId,
    locationId: clinic.locationId,
    amount: 200_000,
    currency: 'COP',
    dueDate: new Date(`${dueDate}T00:00:00.000Z`),
    createdById: authorId,
    ...extra,
  });

  const today = () => civilDateIn(new Date(), BOGOTA);

  describe.each(['collection_notes', 'payment_promises'])('%s', (table) => {
    it('tiene RLS ENABLE + FORCE y la política del tenant', async () => {
      const rows = await raw.$queryRawUnsafe<
        { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
      >(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = '"${table}"'::regclass`,
      );
      expect(rows[0]).toEqual({
        relrowsecurity: true,
        relforcerowsecurity: true,
      });
      const policies = await raw.$queryRaw<{ policyname: string }[]>`
        SELECT policyname FROM pg_policies WHERE tablename = ${table}`;
      expect(policies.map((p) => p.policyname)).toEqual(['tenant_isolation']);
    });
  });

  it('cada clínica ve solo sus notas y compromisos, y no escribe en otra', async () => {
    await raw.collectionNote.create({ data: note(b, b.patients[0]) });
    await raw.paymentPromise.create({
      data: promise(b, b.patients[0], addCivilDays(today(), 5)),
    });
    expect(await asA((tx) => tx.collectionNote.findMany())).toEqual([]);
    expect(await asA((tx) => tx.paymentPromise.findMany())).toEqual([]);
    await expect(
      asA((tx) => tx.collectionNote.create({ data: note(b, b.patients[0]) })),
    ).rejects.toThrow(/row-level security/);
  });

  it('FK compuesta: ni el paciente ni la sede de otra clínica', async () => {
    await expect(
      asA((tx) =>
        tx.collectionNote.create({
          data: note(a, b.patients[0]),
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    await expect(
      asA((tx) =>
        tx.paymentPromise.create({
          data: promise(a, a.patients[0], today(), {
            locationId: b.locationId,
          }),
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('CHECK: nota de más de 280 caracteres e importe no positivo', async () => {
    await expect(
      asA((tx) =>
        tx.collectionNote.create({
          data: note(a, a.patients[0], { text: 'x'.repeat(281) }),
        }),
      ),
    ).rejects.toThrow(/check constraint/);
    await expect(
      asA((tx) =>
        tx.paymentPromise.create({
          data: promise(a, a.patients[0], today(), { amount: 0 }),
        }),
      ),
    ).rejects.toThrow(/check constraint/);
  });

  it('las notas son append-only: ni UPDATE ni DELETE (la app)', async () => {
    const created = await asA((tx) =>
      tx.collectionNote.create({ data: note(a, a.patients[0]) }),
    );
    await expect(
      asA((tx) =>
        tx.collectionNote.update({
          where: { id: created.id },
          data: { text: 'Reescrita' },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
    // El cliente de la app ya prohíbe el borrado duro (no-hard-delete); la
    // BD lo impide también por SQL directo con el rol de la app.
    await expect(
      asA((tx) => tx.collectionNote.delete({ where: { id: created.id } })),
    ).rejects.toThrow(/Borrado duro prohibido/);
    await expect(
      asA(
        (tx) =>
          tx.$executeRaw`DELETE FROM "collection_notes" WHERE "id" = ${created.id}::uuid`,
      ),
    ).rejects.toThrow(IMMUTABLE);
  });

  it('un compromiso solo pasa de OPEN a KEPT/BROKEN una vez; nunca se borra ni se reescribe', async () => {
    await expect(
      asA((tx) =>
        tx.paymentPromise.create({
          data: promise(a, a.patients[1], today(), {
            status: 'KEPT',
            settledAt: new Date(),
          }),
        }),
      ),
    ).rejects.toThrow(/nace abierto/);
    const created = await asA((tx) =>
      tx.paymentPromise.create({ data: promise(a, a.patients[1], today()) }),
    );
    await expect(
      asA((tx) =>
        tx.paymentPromise.update({
          where: { id: created.id },
          data: { amount: 1 },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
    await asA((tx) =>
      tx.paymentPromise.update({
        where: { id: created.id },
        data: { status: 'KEPT', settledAt: new Date() },
      }),
    );
    await expect(
      asA((tx) =>
        tx.paymentPromise.update({
          where: { id: created.id },
          data: { status: 'BROKEN' },
        }),
      ),
    ).rejects.toThrow(IMMUTABLE);
    await expect(
      asA(
        (tx) =>
          tx.$executeRaw`DELETE FROM "payment_promises" WHERE "id" = ${created.id}::uuid`,
      ),
    ).rejects.toThrow(IMMUTABLE);
  });

  it('un solo compromiso abierto por paciente', async () => {
    await asA((tx) =>
      tx.paymentPromise.create({
        data: promise(a, a.patients[2], addCivilDays(today(), 3)),
      }),
    );
    await expect(
      asA((tx) =>
        tx.paymentPromise.create({
          data: promise(a, a.patients[2], addCivilDays(today(), 9)),
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('el barrido cierra cumplidos e incumplidos, una sola vez, auditado sin usuario', async () => {
    const [kept, broken] = [a.patients[3], a.patients[4]];
    const keptPromise = await raw.paymentPromise.create({
      data: promise(a, kept, addCivilDays(today(), 10)),
    });
    const brokenPromise = await raw.paymentPromise.create({
      data: promise(a, broken, addCivilDays(today(), -1)),
    });
    // Abono registrado DESPUÉS del compromiso que lo cubre.
    await raw.payment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        treatmentPlanId: a.planOf.get(kept)!,
        patientId: kept,
        amount: 200_000,
        currency: 'COP',
        paidAt: new Date(),
      },
    });

    const repo = new PrismaCollectionsRepository(prisma, tenantContext);
    const audit = new RecordAuditEventUseCase(
      new PrismaAuditEventRepository(prisma),
    );
    const settle = new SettlePaymentPromises(repo, audit, () => new Date());

    const first = await settle.run();
    expect(first.kept).toBeGreaterThanOrEqual(1);
    expect(first.broken).toBeGreaterThanOrEqual(1);
    const statuses = await raw.paymentPromise.findMany({
      where: { id: { in: [keptPromise.id, brokenPromise.id] } },
      select: { id: true, status: true, settledAt: true },
    });
    expect(new Map(statuses.map((s) => [s.id, s.status]))).toEqual(
      new Map([
        [keptPromise.id, 'KEPT'],
        [brokenPromise.id, 'BROKEN'],
      ]),
    );
    expect(statuses.every((s) => s.settledAt !== null)).toBe(true);

    // Idempotente: el segundo barrido no cambia nada.
    await expect(settle.run()).resolves.toEqual({ kept: 0, broken: 0 });

    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'PAYMENT_PROMISE',
        resourceId: { in: [keptPromise.id, brokenPromise.id] },
      },
      select: {
        resourceId: true,
        actorUserId: true,
        actorRole: true,
        patientId: true,
        metadata: true,
      },
    });
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.resourceId === keptPromise.id)).toMatchObject({
      actorUserId: null,
      actorRole: null,
      patientId: kept,
      metadata: { reason: 'PROMISE_KEPT', origin: 'JOB' },
    });
    expect(events.find((e) => e.resourceId === brokenPromise.id)).toMatchObject(
      {
        metadata: { reason: 'PROMISE_BROKEN', origin: 'JOB' },
      },
    );
  });

  it('el CHECK de auditoría no admite otro evento sin actor sobre un compromiso', async () => {
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.auditEvent.create({
          data: {
            tenantId: a.tenantId,
            action: 'UPDATE',
            resourceType: 'PAYMENT_PROMISE',
            resourceId: a.patients[0],
            metadata: { reason: 'PROMISE_KEPT' },
          },
        }),
      ),
    ).rejects.toThrow(/audit_events_actor_check/);
  });
});
