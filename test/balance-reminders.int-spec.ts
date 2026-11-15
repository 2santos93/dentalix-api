import { ForbiddenException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaCollectionsRepository } from '../src/modules/collections/infrastructure/prisma-collections.repository';
import { PrismaBalanceRemindersRepository } from '../src/modules/receivables/infrastructure/prisma-balance-reminders.repository';
import type { NewCollectionNote } from '../src/modules/collections/domain/collections.entity';
import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../src/shared/time/civil-day';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-146, capa DB: la marca «avisado» de «Por avisar hoy» (nota REMINDER_SENT,
// append-only) con un aviso por paciente y día civil de la sede de su deuda
// (America/Caracas), sin duplicados con dos marcas a la vez; las sedes
// permitidas del miembro; RLS de los avisos y las bajas; y el CHECK de la
// política en `tenants`. Por la MISMA ruta que la app (runWithTenant, rol
// dentalix_app); `raw` (DIRECT_URL, superusuario) siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const collections = new PrismaCollectionsRepository(prisma, tenantContext);
const reminders = new PrismaBalanceRemindersRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx146-int-a', 'dx146-int-b'];
const CARACAS = 'America/Caracas';
const AUTHOR_EMAIL = 'dx146-int@example.com';

interface Clinic {
  tenantId: string;
  este: string;
  oeste: string;
  patients: string[];
}

let authorId: string;

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const tenantId = tenant.id;
  const sede = (name: string) =>
    raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId,
        name,
        country: 'VE',
      }),
    });
  const este = (await sede('Este')).id;
  const oeste = (await sede('Oeste')).id;
  const patients: string[] = [];
  for (const firstName of ['Ana', 'Beto', 'Caro']) {
    const patient = await raw.patient.create({
      data: { tenantId, firstName, lastName: subdomain },
    });
    patients.push(patient.id);
  }
  return { tenantId, este, oeste, patients };
}

/** La sede de la deuda del paciente (la mantiene la BD; aquí se fija). */
async function debtAt(
  clinic: Clinic,
  patientId: string,
  locationId: string,
): Promise<void> {
  await raw.patientLedger.upsert({
    where: { tenantId_patientId: { tenantId: clinic.tenantId, patientId } },
    create: { tenantId: clinic.tenantId, patientId, locationId },
    update: { locationId },
  });
}

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length === 0) return;
  const where = { tenantId: { in: ids } };
  await raw.collectionNote.deleteMany({ where });
  await raw.patientLedger.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
}

function reminderInput(clinic: Clinic, patientId: string): NewCollectionNote {
  return {
    patientId,
    locationId: null,
    channel: 'WHATSAPP_LINK',
    outcome: 'REMINDER_SENT',
    text: null,
    authorId,
  };
}

describe('«Por avisar hoy»: marca avisado y política (int, DX-146)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    await raw.user.deleteMany({ where: { email: AUTHOR_EMAIL } });
    authorId = (
      await raw.user.create({
        data: {
          email: AUTHOR_EMAIL,
          passwordHash: 'x',
          fullName: 'Rita Recepción',
        },
      })
    ).id;
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
    await debtAt(a, a.patients[0], a.este);
    await debtAt(a, a.patients[1], a.oeste);
  });

  afterAll(async () => {
    await cleanup();
    await raw.user.deleteMany({ where: { id: authorId } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('dos «Marcar avisado» a la vez dejan UN aviso (candado del paciente)', async () => {
    const patientId = a.patients[0];
    const now = new Date();
    const results = await Promise.all(
      [0, 1, 2].map(() =>
        tenantContext.run(a.tenantId, () =>
          collections.createReminderNote(reminderInput(a, patientId), now),
        ),
      ),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
    const notes = await raw.collectionNote.findMany({
      where: { tenantId: a.tenantId, patientId, outcome: 'REMINDER_SENT' },
    });
    expect(notes).toHaveLength(1);
  });

  it('el «hoy» es el día civil de Caracas de la sede de la deuda: al día siguiente sí admite otro', async () => {
    const patientId = a.patients[0];
    const [last] = await raw.collectionNote.findMany({
      where: { tenantId: a.tenantId, patientId, outcome: 'REMINDER_SENT' },
      orderBy: { createdAt: 'desc' },
      take: 1,
    });
    const noteDay = civilDateIn(last.createdAt, CARACAS);
    // Último instante del mismo día en Caracas: sigue siendo «hoy».
    const endOfDay = new Date(
      zonedStartOfDay(addCivilDays(noteDay, 1), CARACAS).getTime() - 1,
    );
    await expect(
      tenantContext.run(a.tenantId, () =>
        collections.createReminderNote(reminderInput(a, patientId), endOfDay),
      ),
    ).resolves.toBeNull();
    // Ya es el día siguiente en Caracas (aunque en UTC pueda ser el mismo).
    const nextDay = zonedStartOfDay(addCivilDays(noteDay, 1), CARACAS);
    const created = await tenantContext.run(a.tenantId, () =>
      collections.createReminderNote(reminderInput(a, patientId), nextDay),
    );
    expect(created).toMatchObject({
      outcome: 'REMINDER_SENT',
      channel: 'WHATSAPP_LINK',
      author: { id: authorId },
    });
  });

  it('un miembro acotado a otra sede no marca la deuda de la sede Oeste (403)', async () => {
    const patientId = a.patients[1];
    await expect(
      tenantContext.run(
        a.tenantId,
        undefined,
        () =>
          collections.createReminderNote(
            reminderInput(a, patientId),
            new Date(),
          ),
        [a.este],
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    const allowed = await tenantContext.run(
      a.tenantId,
      undefined,
      () =>
        collections.createReminderNote(reminderInput(a, patientId), new Date()),
      [a.oeste],
    );
    expect(allowed?.patientId).toBe(patientId);
  });

  it('el aviso es append-only: la app no lo edita ni lo borra', async () => {
    const [note] = await raw.collectionNote.findMany({
      where: { tenantId: a.tenantId, outcome: 'REMINDER_SENT' },
      take: 1,
    });
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.collectionNote.update({
          where: { id: note.id },
          data: { outcome: 'NO_ANSWER' },
        }),
      ),
    ).rejects.toThrow(/inalterable|permission denied/);
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          tx.$executeRaw`DELETE FROM "collection_notes" WHERE "id" = ${note.id}::uuid`,
      ),
    ).rejects.toThrow(/inalterable|permission denied/);
  });

  it('RLS: los avisos y las bajas de A no se ven desde B', async () => {
    await raw.patient.update({
      where: { id: a.patients[2] },
      data: { reminderOptOutAt: new Date(), reminderOptOutSource: 'STAFF' },
    });
    const fromA = await tenantContext.run(a.tenantId, async () => ({
      notices: await reminders.noticesOf(a.patients),
      optedOut: await reminders.patientsOptedOut(a.patients),
    }));
    expect(fromA.notices.get(a.patients[0])).toHaveLength(2);
    expect(fromA.notices.get(a.patients[1])).toHaveLength(1);
    expect(fromA.optedOut).toEqual(new Set([a.patients[2]]));

    const fromB = await tenantContext.run(b.tenantId, async () => ({
      notices: await reminders.noticesOf(a.patients),
      optedOut: await reminders.patientsOptedOut(a.patients),
    }));
    expect(fromB.notices.size).toBe(0);
    expect(fromB.optedOut.size).toBe(0);
    // B tampoco marca a un paciente de A: la FK compuesta lo impide.
    await expect(
      tenantContext.run(b.tenantId, () =>
        collections.createReminderNote(
          reminderInput(b, a.patients[0]),
          new Date(),
        ),
      ),
    ).rejects.toThrow();
  });

  it('la política nace en 7/30/60, 3 avisos y 7 días; el CHECK rechaza lo inválido', async () => {
    await expect(
      tenantContext.run(a.tenantId, () => reminders.policy()),
    ).resolves.toEqual({ days: [7, 30, 60], maxNotices: 3, minGapDays: 7 });
    for (const data of [
      { balanceReminderDays: [30, 7] },
      { balanceReminderDays: [7, 7] },
      { balanceReminderDays: [] },
      { balanceReminderDays: [7, 30, 60, 90] },
      { balanceReminderDays: [0] },
      { balanceReminderDays: [400] },
      { balanceReminderMaxNotices: 0 },
      { balanceReminderMaxNotices: 11 },
      { balanceReminderMinGapDays: 0 },
      { balanceReminderMinGapDays: 91 },
    ]) {
      await expect(
        raw.tenant.update({ where: { id: a.tenantId }, data }),
      ).rejects.toThrow(/tenants_balance_reminder/);
    }
    await raw.$executeRaw`UPDATE "tenants" SET "balanceReminderDays" = '{7,NULL}' WHERE "id" = ${a.tenantId}::uuid`.then(
      () => {
        throw new Error('el CHECK debía rechazar un tramo NULL');
      },
      (error: unknown) => {
        expect(String(error)).toMatch(/tenants_balance_reminder_days_check/);
      },
    );
  });
});
