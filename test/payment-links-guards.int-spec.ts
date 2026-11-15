import { randomBytes, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-569, guardas de la BD (payment_links_guard y payment_reports_guard):
// lo que pide el enlace y lo que reportó el paciente no cambian; el enlace
// solo se marca abierto, usado o anulado una vez, sus subidas autorizadas
// solo suben y, usado o anulado, ya no cambia; el reporte solo pasa de
// PENDING a CONFIRMED o REJECTED una vez; nada se borra ni se vacía. Las
// escrituras van como dentalix_app con la clínica fijada (como la app);
// para probar el trigger de DELETE y TRUNCATE (que el privilegio ya frena) se
// concede el privilegio DENTRO de una transacción que se deshace.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const app = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const GUARD =
  /insufficient_privilege|42501|no cambia|no se borra|solo se confirma|no se devuelven/;
const DAY = 86_400_000;

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  planId: string;
  methodId: string;
  userId: string;
}

let s: Seeded;

function asApp<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return app.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_tenant', ${s.tenantId}, true)`;
    return fn(tx);
  });
}

/** Como el dueño, concede a dentalix_app DELETE/TRUNCATE y ejecuta como él; siempre se deshace. */
async function withGrantedDelete(table: string, sql: string): Promise<unknown> {
  return owner
    .$transaction(async (tx) => {
      // Las dos: el TRUNCATE de los enlaces arrastra (CASCADE) los reportes.
      await tx.$executeRawUnsafe(
        `GRANT DELETE, TRUNCATE ON "${table}", "payment_reports" TO dentalix_app`,
      );
      await tx.$executeRawUnsafe('SET LOCAL ROLE dentalix_app');
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${s.tenantId}, true)`;
      await tx.$executeRawUnsafe(sql);
      throw new Error('ROLLBACK: el borrado pasó');
    })
    .catch((error: unknown) => error);
}

async function link(
  over: Partial<Prisma.PaymentLinkUncheckedCreateInput> = {},
) {
  // Un plan por enlace: un enlace vivo por destino (índice parcial).
  const plan = await owner.treatmentPlan.create({
    data: { tenantId: s.tenantId, patientId: s.patientId, currency: 'USD' },
  });
  return owner.paymentLink.create({
    data: {
      tenantId: s.tenantId,
      patientId: s.patientId,
      treatmentPlanId: plan.id,
      locationId: s.locationId,
      amount: 40,
      currency: 'USD',
      concept: 'BALANCE',
      tokenHash: randomBytes(32).toString('hex'),
      expiresAt: new Date(Date.now() + 7 * DAY),
      createdById: s.userId,
      ...over,
    },
  });
}

async function report(
  over: Partial<Prisma.PaymentReportUncheckedCreateInput> = {},
) {
  const used = await link({ usedAt: new Date() });
  return owner.paymentReport.create({
    data: {
      tenantId: s.tenantId,
      linkId: used.id,
      patientId: s.patientId,
      locationId: s.locationId,
      paymentMethodId: s.methodId,
      amount: 10000,
      currency: 'VES',
      reference: 'REF-PACIENTE',
      paidOn: new Date('2026-11-14T00:00:00.000Z'),
      note: 'Pagué la cuota',
      ...over,
    },
  });
}

const updateLink = (
  id: string,
  data: Prisma.PaymentLinkUpdateManyMutationInput,
) => asApp((tx) => tx.paymentLink.updateMany({ where: { id }, data }));
const updateReport = (
  id: string,
  data: Prisma.PaymentReportUncheckedUpdateManyInput,
) => asApp((tx) => tx.paymentReport.updateMany({ where: { id }, data }));
const decided = (status: 'CONFIRMED' | 'REJECTED', paymentId?: string) => ({
  status,
  ...(status === 'CONFIRMED'
    ? { paymentId }
    : { rejectReason: 'No aparece en el banco' }),
  decidedById: s.userId,
  decidedAt: new Date(),
});

async function payment(): Promise<string> {
  return (
    await owner.payment.create({
      data: {
        tenantId: s.tenantId,
        locationId: s.locationId,
        treatmentPlanId: s.planId,
        patientId: s.patientId,
        amount: 40,
        currency: 'USD',
        paidAt: new Date(),
      },
    })
  ).id;
}

describe('guardas de payment_links y payment_reports (DX-569, int)', () => {
  beforeAll(async () => {
    await resetDatabase(owner);
    const tenant = await owner.tenant.create({
      data: { name: 'Guardas', subdomain: 'dx569-guards' },
    });
    const location = await owner.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: tenant.id,
        name: 'Sede',
      }),
    });
    const patient = await owner.patient.create({
      data: { tenantId: tenant.id, firstName: 'Ana', lastName: 'Guardas' },
    });
    const plan = await owner.treatmentPlan.create({
      data: { tenantId: tenant.id, patientId: patient.id, currency: 'USD' },
    });
    const method = await owner.clinicPaymentMethod.create({
      data: { tenantId: tenant.id, name: 'Transferencia', kind: 'TRANSFER' },
    });
    s = {
      tenantId: tenant.id,
      locationId: location.id,
      patientId: patient.id,
      planId: plan.id,
      methodId: method.id,
      userId: randomUUID(),
    };
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await app.$disconnect();
  });

  describe('payment_links', () => {
    it('lo que pide el enlace no cambia: cada columna por separado', async () => {
      const row = await link();
      const otherPlan = await owner.treatmentPlan.create({
        data: { tenantId: s.tenantId, patientId: s.patientId, currency: 'USD' },
      });
      const changes: Prisma.PaymentLinkUncheckedUpdateManyInput[] = [
        { treatmentPlanId: otherPlan.id },
        { amount: 41 },
        { currency: 'VES' },
        { concept: 'INSTALLMENT' },
        { tokenHash: 'f'.repeat(64) },
        { expiresAt: new Date(Date.now() + 8 * DAY) },
        { channel: 'EMAIL' },
        { createdById: randomUUID() },
        { createdAt: new Date(Date.now() - 1000) },
      ];
      for (const data of changes) {
        await expect(
          asApp((tx) =>
            tx.paymentLink.updateMany({ where: { id: row.id }, data }),
          ),
        ).rejects.toThrow(GUARD);
      }
      // patientId, locationId y tenantId (este también lo frena la RLS).
      for (const sql of [
        `UPDATE "payment_links" SET "patientId" = gen_random_uuid() WHERE "id" = '${row.id}'`,
        `UPDATE "payment_links" SET "locationId" = gen_random_uuid() WHERE "id" = '${row.id}'`,
      ]) {
        await expect(asApp((tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow(
          GUARD,
        );
      }
      await expect(
        owner.paymentLink.update({
          where: { id: row.id },
          data: { tenantId: randomUUID() },
        }),
      ).rejects.toThrow(GUARD);
    });

    it('vivo: se abre una vez, las subidas solo suben y el comprobante preparado cambia', async () => {
      const row = await link();
      await updateLink(row.id, { openedAt: new Date() });
      await expect(
        updateLink(row.id, { openedAt: new Date(Date.now() + 1000) }),
      ).rejects.toThrow(GUARD);
      await expect(updateLink(row.id, { openedAt: null })).rejects.toThrow(
        GUARD,
      );
      await updateLink(row.id, { proofUploadsIssued: { increment: 2 } });
      await expect(
        updateLink(row.id, { proofUploadsIssued: { decrement: 1 } }),
      ).rejects.toThrow(GUARD);
      const staged = {
        stagedProofUploadId: randomUUID(),
        stagedProofKey: `payment-proofs/${randomUUID()}.png`,
        stagedProofMime: 'image/png',
        stagedProofSize: 10,
        stagedProofSha256: 'c'.repeat(64),
        stagedProofName: 'captura.png',
      };
      await updateLink(row.id, staged);
      await updateLink(row.id, {
        ...staged,
        stagedProofUploadId: randomUUID(),
      });
      await owner.paymentLink.update({
        where: { id: row.id },
        data: { revokedAt: new Date() },
      });
    });

    it('usado o anulado ya no cambia nada (ni volver atrás, ni la apertura, ni el comprobante)', async () => {
      const used = await link({ usedAt: new Date() });
      const revokedRow = await link({ revokedAt: new Date() });
      for (const id of [used.id, revokedRow.id]) {
        for (const data of [
          { usedAt: null },
          { revokedAt: null },
          { openedAt: new Date() },
          { proofUploadsIssued: { increment: 1 } },
          { stagedProofName: 'otra.png' },
        ] satisfies Prisma.PaymentLinkUpdateManyMutationInput[]) {
          await expect(updateLink(id, data)).rejects.toThrow(GUARD);
        }
      }
      // Ni el dueño de la BD: la guarda no distingue rol al cambiar.
      await expect(
        owner.paymentLink.update({
          where: { id: used.id },
          data: { usedAt: new Date(Date.now() + 1000) },
        }),
      ).rejects.toThrow(GUARD);
    });

    it('DELETE y TRUNCATE prohibidos (privilegio y, concedido, el trigger)', async () => {
      const row = await link({ revokedAt: new Date() });
      await expect(
        asApp((tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM "payment_links" WHERE "id" = '${row.id}'`,
          ),
        ),
      ).rejects.toThrow(/permission denied|42501/);
      const deleted = await withGrantedDelete(
        'payment_links',
        `DELETE FROM "payment_links" WHERE "id" = '${row.id}'`,
      );
      expect(String(deleted)).toMatch(/no se borra un enlace de pago/);
      const truncated = await withGrantedDelete(
        'payment_links',
        'TRUNCATE "payment_links" CASCADE',
      );
      expect(String(truncated)).toMatch(/no se borra un enlace de pago/);
      expect(await owner.paymentLink.count({ where: { id: row.id } })).toBe(1);
    });
  });

  describe('payment_reports', () => {
    it('lo que reportó el paciente no cambia: cada columna por separado', async () => {
      const row = await report();
      const otherMethod = await owner.clinicPaymentMethod.create({
        data: {
          tenantId: s.tenantId,
          name: `Otro ${randomUUID().slice(0, 8)}`,
          kind: 'OTHER',
        },
      });
      const changes: Prisma.PaymentReportUncheckedUpdateManyInput[] = [
        { paymentMethodId: otherMethod.id },
        { amount: 9999 },
        { currency: 'USD' },
        { reference: 'REF-CAMBIADA' },
        { reference: null },
        { paidOn: new Date('2026-11-13T00:00:00.000Z') },
        { note: 'Otra nota' },
        { createdAt: new Date(Date.now() - 1000) },
      ];
      for (const data of changes) {
        await expect(updateReport(row.id, data)).rejects.toThrow(GUARD);
        // Ni siquiera junto con una decisión válida.
        await expect(
          updateReport(row.id, { ...decided('REJECTED'), ...data }),
        ).rejects.toThrow(GUARD);
      }
      for (const sql of [
        `UPDATE "payment_reports" SET "patientId" = gen_random_uuid() WHERE "id" = '${row.id}'`,
        `UPDATE "payment_reports" SET "locationId" = gen_random_uuid() WHERE "id" = '${row.id}'`,
        `UPDATE "payment_reports" SET "linkId" = gen_random_uuid() WHERE "id" = '${row.id}'`,
      ]) {
        await expect(asApp((tx) => tx.$executeRawUnsafe(sql))).rejects.toThrow(
          GUARD,
        );
      }
      await expect(
        owner.paymentReport.update({
          where: { id: row.id },
          data: { tenantId: randomUUID() },
        }),
      ).rejects.toThrow(GUARD);
      expect(
        (await owner.paymentReport.findUniqueOrThrow({ where: { id: row.id } }))
          .status,
      ).toBe('PENDING');
    });

    it('el comprobante del paciente no cambia ni se quita', async () => {
      const row = await report({
        proofUploadId: randomUUID(),
        proofKey: `payment-proofs/${randomUUID()}.png`,
        proofMime: 'image/png',
        proofSize: 10,
        proofSha256: 'c'.repeat(64),
        proofName: 'captura.png',
      });
      for (const data of [
        { proofName: 'otra.png' },
        { proofKey: `payment-proofs/${randomUUID()}.png` },
        {
          proofUploadId: null,
          proofKey: null,
          proofMime: null,
          proofSize: null,
          proofSha256: null,
          proofName: null,
        },
      ]) {
        await expect(updateReport(row.id, data)).rejects.toThrow(GUARD);
      }
    });

    it('pendiente: solo a CONFIRMED o REJECTED, una vez; decidido no cambia', async () => {
      const toPending = await report();
      await expect(
        updateReport(toPending.id, { decidedById: s.userId }),
      ).rejects.toThrow(GUARD);

      const confirmed = await report();
      await updateReport(confirmed.id, decided('CONFIRMED', await payment()));
      const rejected = await report();
      await updateReport(rejected.id, decided('REJECTED'));
      for (const id of [confirmed.id, rejected.id]) {
        for (const data of [
          { status: 'PENDING' as const },
          decided('REJECTED'),
          { decidedAt: new Date(Date.now() + 1000) },
          { rejectReason: 'Otro motivo' },
        ]) {
          await expect(updateReport(id, data)).rejects.toThrow(GUARD);
        }
      }
      await expect(
        updateReport(confirmed.id, { paymentId: await payment() }),
      ).rejects.toThrow(GUARD);
    });

    it('DELETE y TRUNCATE prohibidos (privilegio y, concedido, el trigger)', async () => {
      const row = await report();
      await expect(
        asApp((tx) =>
          tx.$executeRawUnsafe(
            `DELETE FROM "payment_reports" WHERE "id" = '${row.id}'`,
          ),
        ),
      ).rejects.toThrow(/permission denied|42501/);
      const deleted = await withGrantedDelete(
        'payment_reports',
        `DELETE FROM "payment_reports" WHERE "id" = '${row.id}'`,
      );
      expect(String(deleted)).toMatch(/no se borra un reporte de pago/);
      const truncated = await withGrantedDelete(
        'payment_reports',
        'TRUNCATE "payment_reports"',
      );
      expect(String(truncated)).toMatch(/no se borra un reporte de pago/);
      expect(await owner.paymentReport.count({ where: { id: row.id } })).toBe(
        1,
      );
    });
  });
});
