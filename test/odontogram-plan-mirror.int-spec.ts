import { randomUUID } from 'node:crypto';
import { UnprocessableEntityException } from '@nestjs/common';
import {
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  TreatmentPlanItemStatus,
} from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaTreatmentPlanRepository } from '../src/modules/treatment-plans/infrastructure/repositories/prisma-treatment-plan.repository';
import { PrismaToothRecordRepository } from '../src/modules/odontogram/infrastructure/repositories/prisma-tooth-record.repository';
import { activeRecords } from '../src/modules/odontogram/domain/record-projection';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenants } from './support/tenant-purge';

// DX-132: espejo plan → odontograma en la BD, por la MISMA ruta que la app
// (repositorios reales, rol dentalix_app bajo RLS). `raw` (DIRECT_URL,
// superusuario) solo siembra, lee y limpia.
//   - el espejo aplica la regla posición/dentición del alta manual (422) y,
//     si falla, el ítem no queda DONE;
//   - una copia anulada se re-copia con un registro NUEVO al volver a DONE,
//     sin tocar las filas existentes (append-only);
//   - la base respalda la cadena: índice único NULLS NOT DISTINCT, FK
//     compuesta y CHECK de `replacesRecordId`.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const plans = new PrismaTreatmentPlanRepository(prisma, tenantContext);
const records = new PrismaToothRecordRepository(prisma, tenantContext);

const SUBDOMAIN = 'dx132-plan-mirror';
const DONE = TreatmentPlanItemStatus.DONE;
const ACCEPTED = TreatmentPlanItemStatus.ACCEPTED;

interface Seeded {
  tenantId: string;
  userId: string;
  /** 4 años: boca temporal por la edad. */
  childId: string;
  /** Sin fecha de nacimiento: permanente por defecto. */
  adultId: string;
  childPlanId: string;
  adultPlanId: string;
}

let s: Seeded;

function yearsAgo(years: number): Date {
  const d = new Date();
  return new Date(
    Date.UTC(d.getUTCFullYear() - years, d.getUTCMonth(), 1, 0, 0, 0),
  );
}

async function seed(): Promise<Seeded> {
  const { id: tenantId } = await raw.tenant.create({
    data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
  });
  await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId,
      name: 'Sede principal',
    }),
  });
  const user = await raw.user.create({
    data: {
      email: `dx132-${randomUUID()}@example.com`,
      passwordHash: 'x',
      fullName: 'Dra. Odontopediatra',
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId, userId: user.id, role: ClinicRole.DENTIST },
  });
  const child = await raw.patient.create({
    data: {
      tenantId,
      firstName: 'Valentina',
      lastName: 'Pérez',
      birthDate: yearsAgo(4),
    },
  });
  const adult = await raw.patient.create({
    data: { tenantId, firstName: 'José', lastName: 'Rodríguez' },
  });
  const childPlan = await raw.treatmentPlan.create({
    data: { tenantId, patientId: child.id, currency: 'USD' },
  });
  const adultPlan = await raw.treatmentPlan.create({
    data: { tenantId, patientId: adult.id, currency: 'USD' },
  });
  return {
    tenantId,
    userId: user.id,
    childId: child.id,
    adultId: adult.id,
    childPlanId: childPlan.id,
    adultPlanId: adultPlan.id,
  };
}

function inTenant<T>(fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(s.tenantId, fn);
}

const audit = (): AuditRequestContext => ({
  tenantId: s.tenantId,
  locationId: null,
  actor: { userId: s.userId, role: ClinicRole.DENTIST },
  requestId: null,
  ip: null,
  userAgent: null,
});

async function acceptedItem(planId: string, toothNumber: string) {
  return (
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: s.tenantId,
        planId,
        toothNumber,
        catalogItemId: randomUUID(),
        price: 40,
        status: ACCEPTED,
      },
    })
  ).id;
}

function setStatus(
  itemId: string,
  patientId: string,
  status: TreatmentPlanItemStatus,
) {
  return inTenant(() =>
    plans.updateItem(
      itemId,
      () => ({
        patch: { status },
        mirror:
          status === DONE
            ? {
                patientId,
                kind: CatalogKind.PROCEDURE,
                performedById: s.userId,
              }
            : undefined,
      }),
      audit(),
    ),
  );
}

function copiesOf(itemId: string) {
  return raw.toothRecord.findMany({
    where: { sourcePlanItemId: itemId },
    orderBy: [{ recordedAt: 'asc' }, { id: 'asc' }],
  });
}

async function voidRecord(patientId: string, recordId: string) {
  const target = await inTenant(() => records.findById(patientId, recordId));
  const outcome = await inTenant(() =>
    records.createVoid({
      patientId,
      target: target!,
      reason: 'Registrado en el diente equivocado',
      performedById: s.userId,
    }),
  );
  expect(outcome.kind).toBe('CREATED');
}

describe('espejo plan → odontograma (DX-132, int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    s = await seed();
  });

  afterAll(async () => {
    await purgeTenants(raw, [s.tenantId]);
    await raw.user.delete({ where: { id: s.userId } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  describe('regla posición/dentición', () => {
    it('un temporal (55) en una posición permanente: 422 en español, el ítem no queda DONE y no se escribe nada', async () => {
      const itemId = await acceptedItem(s.adultPlanId, '55');

      const err = await setStatus(itemId, s.adultId, DONE).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(UnprocessableEntityException);
      expect((err as UnprocessableEntityException).getResponse()).toEqual({
        statusCode: 422,
        error: 'Unprocessable Entity',
        code: 'TOOTH_DENTITION_MISMATCH',
        message:
          'El diente 55 es temporal, pero la posición 15 está en dentición permanente. Cambia la dentición de esa posición (mixta o temporal) antes de marcarlo como realizado.',
      });
      const item = await raw.treatmentPlanItem.findUniqueOrThrow({
        where: { id: itemId },
      });
      expect(item.status).toBe(ACCEPTED);
      expect(await copiesOf(itemId)).toHaveLength(0);
    });

    it('un permanente (16) en la boca temporal de una niña de 4 años: 422 «aún no ha erupcionado»', async () => {
      const itemId = await acceptedItem(s.childPlanId, '16');
      await expect(setStatus(itemId, s.childId, DONE)).rejects.toMatchObject({
        response: {
          code: 'TOOTH_DENTITION_MISMATCH',
          message: expect.stringMatching(
            /^El diente 16 aún no ha erupcionado/,
          ) as unknown,
        },
      });
      expect(await copiesOf(itemId)).toHaveLength(0);
    });

    it('con la posición cambiada a mixta, el mismo temporal sí se copia', async () => {
      await raw.patientDentitionEvent.create({
        data: {
          tenantId: s.tenantId,
          patientId: s.adultId,
          position: '25',
          dentition: 'MIXED',
          reason: 'MANUAL',
          performedById: s.userId,
        },
      });
      const itemId = await acceptedItem(s.adultPlanId, '65');

      await setStatus(itemId, s.adultId, DONE);

      const copies = await copiesOf(itemId);
      expect(copies).toHaveLength(1);
      expect(copies[0]).toMatchObject({
        toothNumber: '65',
        status: 'COMPLETED',
        replacesRecordId: null,
      });
    });
  });

  describe('re-copia tras una anulación (append-only)', () => {
    it('anulada la copia, volver a DONE inserta otra que la sustituye; las filas previas no cambian', async () => {
      const itemId = await acceptedItem(s.childPlanId, '55');
      await setStatus(itemId, s.childId, DONE);
      const [first] = await copiesOf(itemId);

      // Sin anular: salir de DONE y volver no duplica.
      await setStatus(itemId, s.childId, ACCEPTED);
      await setStatus(itemId, s.childId, DONE);
      expect(await copiesOf(itemId)).toHaveLength(1);

      await voidRecord(s.childId, first.id);
      const firstAfterVoid = await raw.toothRecord.findUniqueOrThrow({
        where: { id: first.id },
      });
      await setStatus(itemId, s.childId, ACCEPTED);
      await setStatus(itemId, s.childId, DONE);

      const copies = await copiesOf(itemId);
      expect(copies).toHaveLength(2);
      expect(copies[1]).toMatchObject({
        toothNumber: '55',
        sourcePlanItemId: itemId,
        replacesRecordId: first.id,
        voidsRecordId: null,
        performedById: s.userId,
      });
      // Append-only: la copia anulada sigue idéntica.
      expect(
        await raw.toothRecord.findUniqueOrThrow({ where: { id: first.id } }),
      ).toEqual(firstAfterVoid);

      // La re-copia deja su propio evento de auditoría.
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: s.tenantId,
          resourceType: 'ODONTOGRAM',
          resourceId: copies[1].id,
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'CREATE',
        patientId: s.childId,
        actorUserId: s.userId,
      });
      expect(events[0].metadata).toMatchObject({
        reason: 'PLAN_ITEM_MIRROR_RECOPIED',
      });

      // Y la cadena sigue: anular la re-copia y volver a DONE sustituye a esa.
      await voidRecord(s.childId, copies[1].id);
      await setStatus(itemId, s.childId, ACCEPTED);
      await setStatus(itemId, s.childId, DONE);
      const third = (await copiesOf(itemId))[2];
      expect(third.replacesRecordId).toBe(copies[1].id);

      // La carta pinta solo la copia viva.
      const chart = activeRecords(
        await inTenant(() => records.listByPatient(s.childId)),
      ).filter((r) => r.sourcePlanItemId === itemId);
      expect(chart.map((r) => r.id)).toEqual([third.id]);
    });

    it('la re-copia también respeta la dentición: con la posición pasada a permanente, 422', async () => {
      const itemId = await acceptedItem(s.childPlanId, '54');
      await setStatus(itemId, s.childId, DONE);
      const [first] = await copiesOf(itemId);
      await voidRecord(s.childId, first.id);
      await raw.patientDentitionEvent.create({
        data: {
          tenantId: s.tenantId,
          patientId: s.childId,
          position: '14',
          dentition: 'PERMANENT',
          reason: 'EXFOLIATION',
          performedById: s.userId,
        },
      });
      await setStatus(itemId, s.childId, ACCEPTED);

      await expect(setStatus(itemId, s.childId, DONE)).rejects.toThrow(
        UnprocessableEntityException,
      );
      expect(await copiesOf(itemId)).toHaveLength(1);
    });

    it('dos DONE concurrentes tras la anulación dejan UNA sola re-copia', async () => {
      const itemId = await acceptedItem(s.childPlanId, '53');
      await setStatus(itemId, s.childId, DONE);
      const [first] = await copiesOf(itemId);
      await voidRecord(s.childId, first.id);
      await setStatus(itemId, s.childId, ACCEPTED);

      await Promise.all([
        setStatus(itemId, s.childId, DONE),
        setStatus(itemId, s.childId, DONE),
      ]);

      expect(await copiesOf(itemId)).toHaveLength(2);
    });
  });

  describe('respaldo de la base', () => {
    function insertCopy(
      itemId: string,
      patientId: string,
      replacesRecordId: string | null,
      sourcePlanItemId: string | null = itemId,
    ) {
      return prisma.runWithTenant(s.tenantId, (tx) =>
        tx.toothRecord.create({
          data: {
            tenantId: s.tenantId,
            patientId,
            toothNumber: '52',
            kind: CatalogKind.PROCEDURE,
            sourcePlanItemId,
            replacesRecordId,
          },
        }),
      );
    }

    it('índice único: una segunda primera copia, o dos re-copias de la misma, chocan (P2002)', async () => {
      const itemId = randomUUID();
      const first = await insertCopy(itemId, s.childId, null);
      await expect(insertCopy(itemId, s.childId, null)).rejects.toMatchObject({
        code: 'P2002',
      });
      await insertCopy(itemId, s.childId, first.id);
      await expect(
        insertCopy(itemId, s.childId, first.id),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('FK compuesta: no sustituye un registro de otro paciente', async () => {
      const other = await insertCopy(randomUUID(), s.adultId, null);
      await expect(
        insertCopy(randomUUID(), s.childId, other.id),
      ).rejects.toMatchObject({ code: 'P2003' });
    });

    it('CHECK: solo una copia del plan sustituye', async () => {
      const first = await insertCopy(randomUUID(), s.childId, null);
      await expect(
        insertCopy(randomUUID(), s.childId, first.id, null),
      ).rejects.toThrow(/tooth_records_replaces_check/);
    });
  });
});
