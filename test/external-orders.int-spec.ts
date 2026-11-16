import { createHash, randomUUID } from 'node:crypto';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaExternalOrderRepository } from '../src/modules/external-orders/infrastructure/prisma-external-order.repository';
import { PrismaExternalOrderCopyRepository } from '../src/modules/external-orders/infrastructure/prisma-external-order-copy.repository';
import type {
  ArchiveExternalOrderPdf,
  NewExternalOrderInput,
} from '../src/modules/external-orders/domain/ports/external-order-repository.port';
import type { ExternalOrderSnapshot } from '../src/modules/external-orders/domain/external-order';
import {
  countLivePublicLinks,
  revokeLivePublicLinks,
} from '../src/modules/patients/infrastructure/patient-public-links';
import {
  backendPid,
  gate,
  settle,
  waitForLockWaiters,
} from './support/postgres-concurrency';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-572 contra Postgres: external_orders con RLS FORCE, FK compuestas a
// paciente (y cita del MISMO paciente y sede), trigger de inmutabilidad (solo
// se enlaza el PDF, se anula y se liga o desliga el resultado; no se borra),
// número correlativo por sede bajo candado (concurrencia real), grants sin
// DELETE y el enlace de UN SOLO USO de la copia.
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaExternalOrderRepository(prisma, tenantContext);
const copies = new PrismaExternalOrderCopyRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx572-int-a', 'dx572-int-b'];

interface Clinic {
  tenantId: string;
  locationId: string;
  otherLocationId: string;
  userId: string;
  membershipId: string;
  patientId: string;
  otherPatientId: string;
}

const snapshot: ExternalOrderSnapshot = {
  version: 1,
  patient: { name: 'Mariela Rondón', document: null, ageYears: 34 },
  professional: {
    name: 'Dra. Ana Pérez',
    license: 'REG-45678',
    specialty: null,
  },
  location: {
    name: 'Sede Chacao',
    address: null,
    healthRegistrationNumber: null,
    timeZone: 'America/Caracas',
    locale: 'es-VE',
    hourCycle: 'h12',
  },
  clinic: { name: 'Clínica', legalName: null, taxIdLabel: null, taxId: null },
};

async function cleanup(): Promise<void> {
  const tenants = await owner.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  // El owner es superusuario: los triggers le dejan borrar.
  await owner.externalOrderCopyLink.deleteMany({ where });
  await owner.externalOrder.deleteMany({ where });
  await owner.externalOrderTemplate.deleteMany({ where });
  await owner.patientCertificate.deleteMany({ where });
  await owner.$executeRaw`DELETE FROM "patient_documents" WHERE "tenantId" = ANY(${ids}::uuid[])`;
  await owner.appointment.deleteMany({ where });
  await owner.patient.deleteMany({ where });
  await owner.clinicMembership.deleteMany({ where });
  await owner.location.deleteMany({ where });
  await owner.tenant.deleteMany({ where: { id: { in: ids } } });
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await owner.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await owner.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Chacao',
    }),
  });
  const other = await owner.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Maracaibo',
    }),
  });
  const user = await owner.user.create({
    data: {
      email: `${subdomain}-${randomUUID()}@example.com`,
      fullName: 'Dra. Ana Pérez',
      passwordHash: 'x',
    },
  });
  const membership = await owner.clinicMembership.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      role: ClinicRole.DENTIST,
      professionalLicense: 'REG-45678',
    },
  });
  const patient = await owner.patient.create({
    data: { tenantId: tenant.id, firstName: 'Mariela', lastName: 'Rondón' },
  });
  const otherPatient = await owner.patient.create({
    data: { tenantId: tenant.id, firstName: 'Luis', lastName: 'Guerra' },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    otherLocationId: other.id,
    userId: user.id,
    membershipId: membership.id,
    patientId: patient.id,
    otherPatientId: otherPatient.id,
  };
}

const asClinic = <T>(clinic: Clinic, fn: () => Promise<T>): Promise<T> =>
  tenantContext.run(clinic.tenantId, fn);

const input = (
  clinic: Clinic,
  over: Partial<NewExternalOrderInput> = {},
): NewExternalOrderInput => ({
  patientId: clinic.patientId,
  locationId: clinic.locationId,
  appointmentId: null,
  professionalMembershipId: clinic.membershipId,
  issuedById: clinic.userId,
  templateId: null,
  content: {
    kind: 'IMAGING',
    recipient: 'Centro de Imagen del Este',
    items: ['Radiografía panorámica'],
    toothNumbers: ['36'],
    clinicalNote: 'Dolor a la percusión en el 36',
  },
  snapshot,
  clinicLogoKey: null,
  ...over,
});

/** Un PDF falso con contenido único (el índice de sha256 vivo por paciente). */
const archive: ArchiveExternalOrderPdf = (order) => {
  const documentId = randomUUID();
  return Promise.resolve({
    documentId,
    storageKey: `int/${documentId}.pdf`,
    sha256: createHash('sha256').update(documentId).digest('hex'),
    sizeBytes: 100,
    originalName: `orden-${order.number}.pdf`,
  });
};

const issue = (clinic: Clinic, over: Partial<NewExternalOrderInput> = {}) =>
  asClinic(clinic, () => repo.issue(input(clinic, over), archive));

/** Un documento vivo del paciente (la radiografía del resultado). */
async function document(clinic: Clinic, patientId = clinic.patientId) {
  const id = randomUUID();
  await owner.patientDocument.create({
    data: {
      id,
      tenantId: clinic.tenantId,
      patientId,
      locationId: clinic.locationId,
      category: 'XRAY',
      originalName: 'panoramica.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      sha256: createHash('sha256').update(id).digest('hex'),
      storageKey: `int/${id}.jpg`,
      uploadedById: clinic.userId,
    },
  });
  return id;
}

/** Una escritura como la app (dentalix_app, RLS de la clínica). */
const asApp = <T>(
  clinic: Clinic,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> => prisma.runWithTenant(clinic.tenantId, fn);

describe('external_orders (int, DX-572)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await cleanup();
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
    await owner.$disconnect();
  });

  it('emite con número de la sede, archiva el PDF (REFERRAL) y lo enlaza; issuedAt la pone el servidor', async () => {
    const order = await issue(a);
    expect(order.number).toBeGreaterThanOrEqual(1);
    expect(order.status).toBe('ISSUED');
    expect(order.documentId).not.toBeNull();
    const doc = await owner.patientDocument.findUniqueOrThrow({
      where: { id: order.documentId! },
    });
    expect(doc).toMatchObject({
      category: 'REFERRAL',
      patientId: a.patientId,
      locationId: a.locationId,
    });
    expect(Math.abs(order.issuedAt.getTime() - Date.now())).toBeLessThan(
      60_000,
    );
  });

  it('numeración concurrente por sede: 8 emisiones a la vez dan números seguidos y sin repetir; otra sede y otra clínica tienen su serie', async () => {
    const before = await owner.externalOrder.aggregate({
      where: { tenantId: a.tenantId, locationId: a.locationId },
      _max: { number: true },
    });
    const start = before._max.number ?? 0;
    const orders = await Promise.all(Array.from({ length: 8 }, () => issue(a)));
    const numbers = orders.map((o) => o.number).sort((x, y) => x - y);
    expect(numbers).toEqual(Array.from({ length: 8 }, (_, i) => start + i + 1));
    const other = await issue(a, { locationId: a.otherLocationId });
    expect(other.number).toBe(1);
    expect((await issue(b)).number).toBe(1);
  });

  it('la cita, si la hay, es del MISMO paciente y de la MISMA sede', async () => {
    const start = new Date(Date.UTC(2026, 10, 3, 13, 0));
    const appt = await owner.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.otherLocationId,
        patientId: a.patientId,
        providerId: a.userId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
      },
    });
    await expect(issue(a, { appointmentId: appt.id })).rejects.toThrow(
      /la sede no es la de la cita/,
    );
    await expect(
      issue(a, {
        appointmentId: appt.id,
        patientId: a.otherPatientId,
        locationId: a.otherLocationId,
      }),
    ).rejects.toThrow(/external_orders_appointment_fkey/);
    const ok = await issue(a, {
      appointmentId: appt.id,
      locationId: a.otherLocationId,
    });
    expect(ok.appointmentId).toBe(appt.id);
  });

  describe('trigger de inmutabilidad', () => {
    const rejectsAsApp = (
      clinic: Clinic,
      sql: (tx: Prisma.TransactionClient) => Promise<unknown>,
      message: RegExp,
    ) => expect(asApp(clinic, sql)).rejects.toThrow(message);

    it.each([
      ['recipient', Prisma.sql`"recipient" = 'Otro centro'`],
      ['items', Prisma.sql`"items" = ARRAY['Otro estudio']`],
      ['clinicalNote', Prisma.sql`"clinicalNote" = 'Otra nota'`],
      ['toothNumbers', Prisma.sql`"toothNumbers" = ARRAY['11']`],
      ['kind', Prisma.sql`"kind" = 'LAB'`],
      ['number', Prisma.sql`"number" = 999`],
      ['issuedAt', Prisma.sql`"issuedAt" = now() - interval '1 day'`],
      ['snapshot', Prisma.sql`"snapshot" = '{}'::jsonb`],
      ['clinicLogoKey', Prisma.sql`"clinicLogoKey" = 'logos/otro.png'`],
    ])('el contenido no cambia: %s', async (_field, set) => {
      const order = await issue(a);
      await rejectsAsApp(
        a,
        (tx) =>
          tx.$executeRaw`UPDATE "external_orders" SET ${set} WHERE "id" = ${order.id}::uuid`,
        /el contenido de una orden emitida no cambia/,
      );
    });

    it('el PDF archivado se enlaza una sola vez', async () => {
      const order = await issue(a);
      const otherDoc = await document(a);
      await rejectsAsApp(
        a,
        (tx) =>
          tx.$executeRaw`UPDATE "external_orders" SET "documentId" = ${otherDoc}::uuid WHERE "id" = ${order.id}::uuid`,
        /el PDF archivado no cambia/,
      );
    });

    it('no se borra ni se vacía, ni siquiera sin la RLS de la app', async () => {
      const order = await issue(a);
      await rejectsAsApp(
        a,
        (tx) =>
          tx.$executeRaw`DELETE FROM "external_orders" WHERE "id" = ${order.id}::uuid`,
        /permission denied|no se borra/,
      );
      const grants = await owner.$queryRaw<
        { del: boolean; trunc: boolean; upd: boolean }[]
      >`
        SELECT has_table_privilege('dentalix_app', 'external_orders', 'DELETE') AS del,
               has_table_privilege('dentalix_app', 'external_orders', 'TRUNCATE') AS trunc,
               has_table_privilege('dentalix_app', 'external_orders', 'UPDATE') AS upd`;
      expect(grants[0]).toEqual({ del: false, trunc: false, upd: true });
    });

    it('nace emitida: ni anulada, ni con resultado, ni con PDF', async () => {
      const doc = await document(a);
      for (const [column, value] of [
        ['status', Prisma.sql`'VOIDED'::"ExternalOrderStatus"`],
        ['resultDocumentId', Prisma.sql`${doc}::uuid`],
        ['documentId', Prisma.sql`${doc}::uuid`],
      ] as const) {
        await expect(
          asApp(
            a,
            (tx) => tx.$executeRaw`INSERT INTO "external_orders"
              ("tenantId","patientId","locationId","professionalMembershipId","issuedById",
               "kind","number","recipient","items","snapshot",${Prisma.raw(`"${column}"`)})
              VALUES (${a.tenantId}::uuid, ${a.patientId}::uuid, ${a.locationId}::uuid,
                ${a.membershipId}::uuid, ${a.userId}::uuid, 'IMAGING', 0, 'Centro',
                ARRAY['Panorámica'], '{}'::jsonb, ${value})`,
          ),
        ).rejects.toThrow(/nace emitida, sin anular, sin resultado y sin PDF/);
      }
    });

    it('transiciones: ISSUED → RESULT_RECEIVED → ISSUED → VOIDED; nada sale de VOIDED', async () => {
      const order = await issue(a);
      const doc = await document(a);
      const linked = await asClinic(a, () =>
        repo.linkResult(order.id, undefined, doc, a.userId),
      );
      expect(linked.kind).toBe('LINKED');
      // RESULT_RECEIVED → VOIDED no: se desliga antes.
      const voidLinked = await asClinic(a, () =>
        repo.voidOrder(
          order.id,
          undefined,
          { userId: a.userId, reason: 'Estudio equivocado' },
          () => undefined,
          archive,
        ),
      );
      expect(voidLinked).toEqual({ kind: 'NOT_ISSUED' });
      await rejectsAsApp(
        a,
        (tx) =>
          tx.$executeRaw`UPDATE "external_orders" SET "status" = 'VOIDED', "voidedAt" = now(),
            "voidedById" = ${a.userId}::uuid, "voidReason" = 'Saltando la regla'
            WHERE "id" = ${order.id}::uuid`,
        /transición de RESULT_RECEIVED a VOIDED no admitida/,
      );
      const unlinked = await asClinic(a, () =>
        repo.unlinkResult(order.id, undefined, () => undefined),
      );
      expect(unlinked.kind).toBe('UNLINKED');
      if (unlinked.kind !== 'UNLINKED') return;
      expect(unlinked.order).toMatchObject({
        status: 'ISSUED',
        resultDocumentId: null,
        resultLinkedAt: null,
      });
      const voided = await asClinic(a, () =>
        repo.voidOrder(
          order.id,
          undefined,
          { userId: a.userId, reason: 'Estudio equivocado' },
          () => undefined,
          archive,
        ),
      );
      expect(voided.kind).toBe('VOIDED');
      if (voided.kind !== 'VOIDED') return;
      expect(voided.order.voidedDocumentId).not.toBeNull();
      const original = await owner.patientDocument.findUniqueOrThrow({
        where: { id: order.documentId! },
      });
      expect(original.voidReason).toBe('Orden anulada: Estudio equivocado');
      await rejectsAsApp(
        a,
        (tx) =>
          tx.$executeRaw`UPDATE "external_orders" SET "status" = 'ISSUED', "voidedAt" = NULL,
            "voidedById" = NULL, "voidReason" = NULL WHERE "id" = ${order.id}::uuid`,
        /transición de VOIDED a ISSUED no admitida/,
      );
      const twice = await asClinic(a, () =>
        repo.voidOrder(
          order.id,
          undefined,
          { userId: a.userId, reason: 'Otra vez' },
          () => undefined,
          archive,
        ),
      );
      expect(twice).toEqual({ kind: 'ALREADY_VOIDED' });
    });

    it('el estado y sus campos van juntos (CHECK) y la anulación solo cambia con el estado', async () => {
      const order = await issue(a);
      await rejectsAsApp(
        a,
        (tx) =>
          tx.$executeRaw`UPDATE "external_orders" SET "status" = 'VOIDED' WHERE "id" = ${order.id}::uuid`,
        /external_orders_void_check/,
      );
      await rejectsAsApp(
        a,
        (tx) =>
          tx.$executeRaw`UPDATE "external_orders" SET "voidReason" = 'Sin anular' WHERE "id" = ${order.id}::uuid`,
        /solo cambian con el estado|external_orders_void_check/,
      );
    });

    it('el resultado es un documento vivo del MISMO paciente; uno puede ser de varias órdenes', async () => {
      const first = await issue(a);
      const second = await issue(a);
      const foreign = await document(a, a.otherPatientId);
      await expect(
        asClinic(a, () =>
          repo.linkResult(first.id, undefined, foreign, a.userId),
        ),
      ).resolves.toEqual({ kind: 'DOCUMENT_NOT_FOUND' });
      const doc = await document(a);
      await owner.patientDocument.update({
        where: { id: doc },
        data: {
          voidedAt: new Date(),
          voidedById: a.userId,
          voidReason: 'Subido por error',
        },
      });
      await expect(
        asClinic(a, () => repo.linkResult(first.id, undefined, doc, a.userId)),
      ).resolves.toEqual({ kind: 'DOCUMENT_VOIDED' });
      const shared = await document(a);
      for (const order of [first, second]) {
        const linked = await asClinic(a, () =>
          repo.linkResult(order.id, undefined, shared, a.userId),
        );
        expect(linked.kind).toBe('LINKED');
      }
      await expect(
        asClinic(a, () =>
          repo.linkResult(first.id, undefined, shared, a.userId),
        ),
      ).resolves.toEqual({ kind: 'NOT_ISSUED' });
    });
  });

  /** Un paciente propio para las pruebas que lo archivan. */
  const freshPatient = async (clinic: Clinic) =>
    (
      await owner.patient.create({
        data: {
          tenantId: clinic.tenantId,
          firstName: 'Carmen',
          lastName: `Archivable ${randomUUID().slice(0, 8)}`,
        },
      })
    ).id;

  it('emitir bloquea al paciente vivo: archivado, 409 y no queda orden', async () => {
    const patientId = await freshPatient(a);
    await owner.patient.update({
      where: { id: patientId },
      data: { deletedAt: new Date() },
    });
    await expect(issue(a, { patientId })).rejects.toThrow(
      'El paciente está archivado: no se emiten documentos nuevos a su nombre.',
    );
    expect(await owner.externalOrder.count({ where: { patientId } })).toBe(0);
  });

  it('el resultado no puede ser un PDF generado (de una orden, vivo o anulado, o de un certificado)', async () => {
    const order = await issue(a);
    const target = await issue(a);
    await expect(
      asClinic(a, () =>
        repo.linkResult(target.id, undefined, order.documentId!, a.userId),
      ),
    ).resolves.toEqual({ kind: 'DOCUMENT_GENERATED' });
    const voided = await asClinic(a, () =>
      repo.voidOrder(
        order.id,
        undefined,
        { userId: a.userId, reason: 'Estudio equivocado' },
        () => undefined,
        archive,
      ),
    );
    if (voided.kind !== 'VOIDED') throw new Error(voided.kind);
    await expect(
      asClinic(a, () =>
        repo.linkResult(
          target.id,
          undefined,
          voided.order.voidedDocumentId!,
          a.userId,
        ),
      ),
    ).resolves.toEqual({ kind: 'DOCUMENT_GENERATED' });
    // El PDF de un certificado del paciente, tampoco.
    const certDoc = await document(a);
    const start = new Date(Date.UTC(2026, 10, 4, 13, 0));
    const appt = await owner.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.locationId,
        patientId: a.patientId,
        providerId: a.userId,
        start,
        end: new Date(start.getTime() + 30 * 60_000),
      },
    });
    await owner.$executeRaw`INSERT INTO "patient_certificates"
      ("tenantId","patientId","appointmentId","locationId","professionalMembershipId",
       "issuedById","kind","number","attendedFrom","attendedUntil","timesSource","snapshot")
      VALUES (${a.tenantId}::uuid, ${a.patientId}::uuid, ${appt.id}::uuid, ${a.locationId}::uuid,
        ${a.membershipId}::uuid, ${a.userId}::uuid, 'ATTENDANCE', 0, now(), now(), 'SCHEDULED', '{}'::jsonb)`;
    await owner.$executeRaw`UPDATE "patient_certificates" SET "documentId" = ${certDoc}::uuid
      WHERE "appointmentId" = ${appt.id}::uuid`;
    await expect(
      asClinic(a, () =>
        repo.linkResult(target.id, undefined, certDoc, a.userId),
      ),
    ).resolves.toEqual({ kind: 'DOCUMENT_GENERATED' });
    // Un estudio subido sí.
    const study = await document(a);
    await expect(
      asClinic(a, () => repo.linkResult(target.id, undefined, study, a.userId)),
    ).resolves.toMatchObject({ kind: 'LINKED' });
  });

  it('anular una orden de una sede no permitida con el paciente archivado: NOT_FOUND, no el 409 de archivado', async () => {
    const patientId = await freshPatient(a);
    const order = await issue(a, { patientId, locationId: a.otherLocationId });
    await owner.patient.update({
      where: { id: patientId },
      data: { deletedAt: new Date() },
    });
    await expect(
      asClinic(a, () =>
        repo.voidOrder(
          order.id,
          [a.locationId],
          { userId: a.userId, reason: 'Estudio equivocado' },
          () => undefined,
          archive,
        ),
      ),
    ).resolves.toEqual({ kind: 'NOT_FOUND' });
    // Con la sede permitida, sí el 409 de archivado.
    await expect(
      asClinic(a, () =>
        repo.voidOrder(
          order.id,
          undefined,
          { userId: a.userId, reason: 'Estudio equivocado' },
          () => undefined,
          archive,
        ),
      ),
    ).rejects.toThrow(/El paciente está archivado/);
  });

  it('anular frente a archivar a la vez (con un enlace vivo): sin interbloqueo; archivar gana y anular da 409', async () => {
    const patientId = await freshPatient(a);
    const order = await issue(a, { patientId });
    await asClinic(a, () =>
      copies.issueLink({
        id: randomUUID(),
        orderId: order.id,
        patientId,
        channel: 'WHATSAPP',
        destinationMasked: '••• 4567',
        tokenHash: createHash('sha256').update(randomUUID()).digest('hex'),
        expiresAt: new Date(Date.now() + 3_600_000),
        createdById: a.userId,
        now: new Date(),
      }),
    );
    // Archivar como la app: bloquea al paciente (FOR UPDATE) y, cuando se le
    // dice, anula sus enlaces y lo archiva en la MISMA transacción.
    const locked = gate<number>();
    const proceed = gate();
    const archiving = settle(
      asApp(a, async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "patients"
          WHERE "id" = ${patientId}::uuid FOR UPDATE`;
        locked.open(await backendPid(tx));
        await proceed.wait;
        const now = new Date();
        const revoked = await revokeLivePublicLinks(tx, {
          tenantId: a.tenantId,
          patientId,
          now,
          actorId: a.userId,
        });
        await tx.patient.update({
          where: { id: patientId },
          data: { deletedAt: now },
        });
        return revoked;
      }),
    );
    const archivePid = await locked.wait;
    const voiding = settle(
      asClinic(a, () =>
        repo.voidOrder(
          order.id,
          undefined,
          { userId: a.userId, reason: 'Estudio equivocado' },
          () => undefined,
          archive,
        ),
      ),
    );
    // Anular espera al paciente que tiene archivar (señal de pg_locks).
    await waitForLockWaiters(owner, [archivePid]);
    proceed.open();
    const [archived, voided] = await Promise.all([archiving, voiding]);
    for (const outcome of [archived, voided]) {
      if (outcome.status === 'rejected') {
        expect(String(outcome.reason)).not.toMatch(/40P01|deadlock/i);
      }
    }
    expect(archived).toMatchObject({
      status: 'fulfilled',
      value: { externalOrderCopies: 1 },
    });
    expect(voided.status).toBe('rejected');
    if (voided.status === 'rejected') {
      expect(String(voided.reason)).toMatch(/El paciente está archivado/);
    }
    const row = await owner.externalOrder.findUniqueOrThrow({
      where: { id: order.id },
    });
    expect(row.status).toBe('ISSUED');
    const links = await owner.externalOrderCopyLink.findMany({
      where: { orderId: order.id },
    });
    expect(links.every((l) => l.revokedAt !== null)).toBe(true);
  });

  it('RLS FORCE: otra clínica no ve, no lee, no anula ni liga; no puede insertar con el tenant de A', async () => {
    const order = await issue(a);
    await expect(
      asClinic(b, () => repo.listForPatient(a.patientId)),
    ).resolves.toBeNull();
    await expect(asClinic(b, () => repo.get(order.id))).resolves.toBeNull();
    await expect(
      asClinic(b, () =>
        repo.voidOrder(
          order.id,
          undefined,
          { userId: b.userId, reason: 'Intrusa desde B' },
          () => undefined,
          archive,
        ),
      ),
    ).resolves.toEqual({ kind: 'NOT_FOUND' });
    const docB = await document(b);
    await expect(
      asClinic(b, () => repo.linkResult(order.id, undefined, docB, b.userId)),
    ).resolves.toEqual({ kind: 'NOT_FOUND' });
    for (const table of [
      'external_orders',
      'external_order_copy_links',
      'external_order_templates',
    ]) {
      const [rls] = await owner.$queryRaw<{ on: boolean; forced: boolean }[]>`
        SELECT relrowsecurity AS "on", relforcerowsecurity AS forced
          FROM pg_class WHERE relname = ${table}`;
      expect({ table, ...rls }).toEqual({ table, on: true, forced: true });
    }
    const visible = await asApp(b, (tx) =>
      tx.externalOrder.count({ where: { tenantId: a.tenantId } }),
    );
    expect(visible).toBe(0);
    await expect(
      asApp(
        b,
        (tx) => tx.$executeRaw`INSERT INTO "external_orders"
          ("tenantId","patientId","locationId","professionalMembershipId","issuedById",
           "kind","number","recipient","items","snapshot")
          VALUES (${a.tenantId}::uuid, ${a.patientId}::uuid, ${a.locationId}::uuid,
            ${a.membershipId}::uuid, ${a.userId}::uuid, 'IMAGING', 0, 'Centro',
            ARRAY['Panorámica'], '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/row-level security|violates foreign key/);
  });

  describe('enlace de un solo uso de la copia', () => {
    const tokenHash = () =>
      createHash('sha256').update(randomUUID()).digest('hex');
    const sendLink = (clinic: Clinic, orderId: string, now = new Date()) => {
      const id = randomUUID();
      return asClinic(clinic, async () => ({
        id,
        outcome: await copies.issueLink({
          id,
          orderId,
          patientId: clinic.patientId,
          channel: 'EMAIL',
          destinationMasked: 'm***@example.com',
          tokenHash: tokenHash(),
          expiresAt: new Date(now.getTime() + 7 * 24 * 3_600_000),
          createdById: clinic.userId,
          now,
        }),
      }));
    };
    const meta = { requestId: null, ip: null, userAgent: null };
    const consume = (clinic: Clinic, linkId: string) =>
      asClinic(clinic, () =>
        copies.consume({
          linkId,
          now: new Date(),
          meta,
          render: () => Promise.resolve(Buffer.from('%PDF-1.4')),
        }),
      );

    it('se gasta al descargar: la segunda descarga ve el enlace usado; dos a la vez, una gana', async () => {
      const order = await issue(a);
      const { id, outcome } = await sendLink(a, order.id);
      expect(outcome).toBe('ISSUED');
      const [x, y] = await Promise.all([consume(a, id), consume(a, id)]);
      expect([x.kind, y.kind].sort()).toEqual(['DOWNLOADED', 'USED']);
      expect((await consume(a, id)).kind).toBe('USED');
      const events = await owner.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceType: 'EXTERNAL_ORDER',
          resourceId: order.id,
          action: 'EXPORT',
        },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorUserId: null,
        patientId: a.patientId,
        metadata: {
          origin: 'PUBLIC_LINK',
          reason: 'EXTERNAL_ORDER_COPY_DOWNLOADED',
        },
      });
    });

    it('reenviar invalida el anterior (como mucho uno vivo); anular la orden invalida el vivo', async () => {
      const order = await issue(a);
      const first = await sendLink(a, order.id);
      const second = await sendLink(a, order.id);
      expect((await consume(a, first.id)).kind).toBe('GONE');
      const live = await owner.externalOrderCopyLink.count({
        where: { orderId: order.id, revokedAt: null, usedAt: null },
      });
      expect(live).toBe(1);
      await asClinic(a, () =>
        repo.voidOrder(
          order.id,
          undefined,
          { userId: a.userId, reason: 'Estudio equivocado' },
          () => undefined,
          archive,
        ),
      );
      expect((await consume(a, second.id)).kind).toBe('GONE');
      await expect(sendLink(a, order.id)).resolves.toMatchObject({
        outcome: 'VOIDED',
      });
    });

    it('el índice parcial impide dos vivos y el trigger: usado o invalidado no cambia', async () => {
      const order = await issue(a);
      const { id } = await sendLink(a, order.id);
      await expect(
        asApp(a, (tx) =>
          tx.externalOrderCopyLink.create({
            data: {
              tenantId: a.tenantId,
              patientId: a.patientId,
              orderId: order.id,
              channel: 'WHATSAPP',
              destinationMasked: '••• 4567',
              tokenHash: tokenHash(),
              expiresAt: new Date(Date.now() + 3_600_000),
              createdById: a.userId,
            },
          }),
        ),
      ).rejects.toThrow(/external_order_copy_links_live_key|Unique constraint/);
      expect((await consume(a, id)).kind).toBe('DOWNLOADED');
      await expect(
        asApp(a, (tx) =>
          tx.externalOrderCopyLink.update({
            where: { id },
            data: { revokedAt: new Date() },
          }),
        ),
      ).rejects.toThrow(/un enlace usado o invalidado no cambia/);
      await expect(
        asApp(
          a,
          (tx) =>
            tx.$executeRaw`DELETE FROM "external_order_copy_links" WHERE "id" = ${id}::uuid`,
        ),
      ).rejects.toThrow(/permission denied|no se borra/);
    });

    it('DX-461: archivar al paciente cuenta e invalida su enlace vivo (el usado no cuenta)', async () => {
      const used = await issue(a, { patientId: a.otherPatientId });
      const live = await issue(a, { patientId: a.otherPatientId });
      const send = (orderId: string) =>
        asClinic(a, () =>
          copies.issueLink({
            id: randomUUID(),
            orderId,
            patientId: a.otherPatientId,
            channel: 'WHATSAPP',
            destinationMasked: '••• 4567',
            tokenHash: tokenHash(),
            expiresAt: new Date(Date.now() + 3_600_000),
            createdById: a.userId,
            now: new Date(),
          }),
        );
      await send(used.id);
      await send(live.id);
      const usedLink = await owner.externalOrderCopyLink.findFirstOrThrow({
        where: { orderId: used.id },
      });
      expect((await consume(a, usedLink.id)).kind).toBe('DOWNLOADED');
      const scope = {
        tenantId: a.tenantId,
        patientId: a.otherPatientId,
        now: new Date(),
      };
      await expect(
        asApp(a, (tx) => countLivePublicLinks(tx, scope)),
      ).resolves.toMatchObject({ externalOrderCopies: 1 });
      await expect(
        asApp(a, (tx) =>
          revokeLivePublicLinks(tx, { ...scope, actorId: a.userId }),
        ),
      ).resolves.toMatchObject({ externalOrderCopies: 1 });
      const rows = await owner.externalOrderCopyLink.findMany({
        where: { patientId: a.otherPatientId },
      });
      expect(
        rows.map((r) => [r.orderId === live.id, r.revokedAt !== null]).sort(),
      ).toEqual([
        [false, false],
        [true, true],
      ]);
    });

    it('otra clínica no gasta ni ve el enlace de A', async () => {
      const order = await issue(a);
      const { id } = await sendLink(a, order.id);
      expect((await consume(b, id)).kind).toBe('GONE');
      expect((await consume(a, id)).kind).toBe('DOWNLOADED');
    });
  });
});
