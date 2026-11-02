import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaCollectionsRepository } from '../src/modules/collections/infrastructure/prisma-collections.repository';
import { SettlePaymentPromises } from '../src/modules/collections/application/settle-payment-promises';
import { RecordAuditEventUseCase } from '../src/modules/audit/application/record-audit-event.use-case';
import { PrismaAuditEventRepository } from '../src/modules/audit/infrastructure/prisma-audit-event.repository';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-226 (DB-037): la regla del compromiso (payment-promise-rule.ts) compara
// el alta del abono con la del compromiso. Las dos horas las pone ahora el
// servidor de BD en UTC (misma fuente): ni la zona de la sesión ni un reloj de
// la API desfasado ±5 s respecto de la BD cambian qué abono es anterior al
// compromiso. El desfase se simula como lo haría Prisma, que manda en el
// INSERT el `createdAt` de su propio reloj, y con el reloj inyectado del
// barrido. Todo como dentalix_app con la clínica fijada; `raw` (DIRECT_URL,
// superusuario) siembra, lee y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUBDOMAIN = 'dx226-promesa-int';
const EMAIL = 'caja@dx226-promesa-int.test';
const ZONE = 'America/Bogota';
const SKEWS = [5, -5];

let tenantId: string;
let locationId: string;
let userId: string;

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: SUBDOMAIN },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  // Superusuario: los triggers append-only dejan la purga administrativa.
  await raw.auditEvent.deleteMany({ where });
  await raw.paymentPromise.deleteMany({ where });
  await raw.payment.deleteMany({ where });
  await raw.treatmentPlan.deleteMany({ where });
  await raw.patientLedger.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { subdomain: SUBDOMAIN } });
  await raw.user.deleteMany({ where: { email: EMAIL } });
}

/** Como la API, pero con la sesión en la zona de la sede. */
function inBogota<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.runWithTenant(tenantId, async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL TIME ZONE '${ZONE}'`);
    return fn(tx);
  });
}

async function patientWithPlan(name: string) {
  const patient = await raw.patient.create({
    data: { tenantId, firstName: name, lastName: 'Reloj' },
  });
  const plan = await raw.treatmentPlan.create({
    data: {
      tenantId,
      patientId: patient.id,
      currency: 'COP',
      status: 'ACCEPTED',
    },
  });
  return { patientId: patient.id, planId: plan.id };
}

/**
 * Abono de 200 000 con el `createdAt` que mandaría una API cuyo reloj va
 * `skew` segundos por delante (o por detrás) del de la BD.
 */
function payWithSkewedClock(
  p: { patientId: string; planId: string },
  skew: number,
) {
  return inBogota(
    (tx) => tx.$executeRaw`
      INSERT INTO "payments" ("id", "tenantId", "locationId", "treatmentPlanId", "patientId",
        "amount", "currency", "paidAt", "createdAt", "updatedAt")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${locationId}::uuid, ${p.planId}::uuid,
        ${p.patientId}::uuid, 200000, 'COP', now() AT TIME ZONE 'UTC',
        (now() AT TIME ZONE 'UTC') + make_interval(secs => ${skew}),
        now() AT TIME ZONE 'UTC')`,
  );
}

async function promiseFor(patientId: string): Promise<string> {
  const [{ id }] = await inBogota(
    (tx) => tx.$queryRaw<{ id: string }[]>`
      INSERT INTO "payment_promises" ("id", "tenantId", "patientId", "locationId", "amount",
        "currency", "dueDate", "createdById")
      VALUES (gen_random_uuid(), ${tenantId}::uuid, ${patientId}::uuid, ${locationId}::uuid,
        200000, 'COP', (now() AT TIME ZONE 'UTC')::date + 10, ${userId}::uuid)
      RETURNING "id"`,
  );
  return id;
}

/** Cierre tras el abono, con el reloj de la API desfasado `skew` segundos. */
async function settle(patientId: string, skew: number): Promise<string> {
  const settler = new SettlePaymentPromises(
    new PrismaCollectionsRepository(prisma, tenantContext),
    new RecordAuditEventUseCase(new PrismaAuditEventRepository(prisma)),
    () => new Date(Date.now() + skew * 1000),
  );
  const context: AuditRequestContext = {
    tenantId,
    locationId,
    actor: { userId, role: 'RECEPTION' },
    requestId: null,
    ip: null,
    userAgent: null,
  };
  await settler.afterPayment(patientId, context);
  const row = await raw.paymentPromise.findFirstOrThrow({
    where: { tenantId, patientId },
    select: { status: true },
  });
  return row.status;
}

describe('compromiso de pago con la hora de la BD como única fuente (DX-226, int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    tenantId = (
      await raw.tenant.create({
        data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
      })
    ).id;
    locationId = (
      await raw.location.create({
        data: locationData(REGIONAL_BOGOTA_FIXTURE, {
          tenantId,
          name: 'Sede',
          country: 'CO',
        }),
      })
    ).id;
    userId = (
      await raw.user.create({
        data: { email: EMAIL, passwordHash: 'x', fullName: 'Caja Reloj' },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it.each(SKEWS)(
    'un abono registrado ANTES del compromiso no lo cumple (reloj de la API %i s respecto de la BD)',
    async (skew) => {
      const p = await patientWithPlan(`Antes${skew > 0 ? 'Mas' : 'Menos'}`);
      await payWithSkewedClock(p, skew);
      await promiseFor(p.patientId);
      expect(await settle(p.patientId, skew)).toBe('OPEN');
    },
  );

  it.each(SKEWS)(
    'un abono registrado DESPUÉS del compromiso lo cumple (reloj de la API %i s respecto de la BD)',
    async (skew) => {
      const p = await patientWithPlan(`Despues${skew > 0 ? 'Mas' : 'Menos'}`);
      await promiseFor(p.patientId);
      await payWithSkewedClock(p, skew);
      expect(await settle(p.patientId, skew)).toBe('KEPT');
    },
  );
});
