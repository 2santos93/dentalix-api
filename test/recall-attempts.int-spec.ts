import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaRecallRepository } from '../src/modules/recall/infrastructure/prisma-recall.repository';
import { recallOnAppointmentBookedInTx } from '../src/modules/recall/infrastructure/recall-from-appointment';
import {
  CreateRecallContactUseCase,
  ListDueRecallsUseCase,
} from '../src/modules/recall/application/use-cases/recall.use-cases';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { SEDE_FIXTURE_ZONE, fixedSedeDay } from './support/sede-clock';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import { seedDefaultRecallTypes } from './support/recall-types';

// DX-465 (D8, capa BD): el ciclo de intentos con el repositorio Prisma REAL
// como `dentalix_app` (RLS FORCE); `raw` (owner) solo siembra y lee. La hora
// del intento es la del servidor de BD (trigger); el «hoy» de la lista se
// inyecta como el mediodía de un día civil de la sede calculado desde el día
// del intento (invariante DX-449: nunca «ahora + N»).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repository = new PrismaRecallRepository(prisma, tenantContext);

const SUBDOMAINS = ['dx465-int-a', 'dx465-int-b'];
const ZONE = SEDE_FIXTURE_ZONE;
const noonOf = (day: string) => new Date(`${day}T12:00:00-04:00`);
const DAY = (d: string) => new Date(`${d}T00:00:00.000Z`);

interface Clinic {
  tenantId: string;
  locationId: string;
  otherLocationId: string;
  authorId: string;
  hygieneTypeId: string;
  checkupTypeId: string;
  appointmentTypeId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const loc = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Chacao',
      timeZone: ZONE,
    }),
  });
  const other = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Maracaibo',
      timeZone: ZONE,
    }),
  });
  const types = await seedDefaultRecallTypes(raw, tenant.id);
  const author = await raw.user.create({
    data: {
      email: `recepcion@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Recepción Chacao',
    },
  });
  await raw.clinicMembership.create({
    data: { tenantId: tenant.id, userId: author.id, role: 'RECEPTION' },
  });
  const appointmentType = await raw.appointmentType.create({
    data: {
      tenantId: tenant.id,
      name: 'Limpieza',
      durationMinutes: 30,
      color: '#0EA5E9',
    },
  });
  await raw.recallType.update({
    where: { id: types.HYGIENE },
    data: { appointmentTypeId: appointmentType.id },
  });
  return {
    tenantId: tenant.id,
    locationId: loc.id,
    otherLocationId: other.id,
    authorId: author.id,
    hygieneTypeId: types.HYGIENE,
    checkupTypeId: types.CHECKUP,
    appointmentTypeId: appointmentType.id,
  };
}

/** Paciente con un recall de higiene vencido (6 meses desde el 01/01/2025). */
async function seedRecall(
  c: Clinic,
  over: { lastDoneAt?: string; phone?: string; typeId?: string } = {},
): Promise<{ patientId: string; recallId: string; dueAt: string }> {
  const patient = await raw.patient.create({
    data: {
      tenantId: c.tenantId,
      firstName: 'Carmen',
      lastName: `Rondón ${randomUUID().slice(0, 6)}`,
      phone: over.phone ?? '+58 412 555 0101',
    },
  });
  const recall = await raw.patientRecall.create({
    data: {
      tenantId: c.tenantId,
      patientId: patient.id,
      recallTypeId: over.typeId ?? c.hygieneTypeId,
      intervalMonths: 6,
      lastDoneAt: DAY(over.lastDoneAt ?? '2025-01-01'),
      locationId: c.locationId,
      createdById: c.authorId,
      updatedById: c.authorId,
    },
    select: { id: true, dueAt: true },
  });
  return {
    patientId: patient.id,
    recallId: recall.id,
    dueAt: recall.dueAt.toISOString().slice(0, 10),
  };
}

async function appointmentOf(
  c: Clinic,
  patientId: string,
  typeId: string | null,
): Promise<string> {
  const start = noonOf(addCivilDays(fixedSedeDay().day, 30));
  const row = await raw.appointment.create({
    data: {
      tenantId: c.tenantId,
      locationId: c.locationId,
      patientId,
      providerId: randomUUID(),
      appointmentTypeId: typeId,
      start,
      end: new Date(start.getTime() + 30 * 60_000),
    },
    select: { id: true },
  });
  return row.id;
}

const inClinic = <T>(c: Clinic, fn: () => Promise<T>) =>
  tenantContext.run(c.tenantId, undefined, fn);

function record(
  c: Clinic,
  recallId: string,
  input: Parameters<CreateRecallContactUseCase['execute']>[1],
  now = fixedSedeDay(0).at,
) {
  const useCase = new CreateRecallContactUseCase(
    repository,
    tenantContext,
    () => now,
  );
  return inClinic(c, () => useCase.execute(recallId, input, c.authorId));
}

async function listIds(
  c: Clinic,
  now: Date,
  flags: { includeContacted?: boolean; exhausted?: boolean } = {},
): Promise<Map<string, { attempts: number; hiddenUntil: string | null }>> {
  const useCase = new ListDueRecallsUseCase(repository, () => now);
  const page = await inClinic(c, () =>
    useCase.execute({ ...flags, withinDays: 0, pageSize: 100 }),
  );
  return new Map(
    page.items.map((i) => [
      i.recallId,
      { attempts: i.attempts, hiddenUntil: i.hiddenUntil },
    ]),
  );
}

/** El día civil (sede) del último contacto del recall. */
async function contactDay(recallId: string): Promise<string> {
  const row = await raw.recallContact.findFirstOrThrow({
    where: { recallId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true },
  });
  return civilDateIn(row.createdAt, ZONE);
}

const actorOf = (c: Clinic): AuditRequestContext => ({
  tenantId: c.tenantId,
  locationId: c.locationId,
  actor: { userId: c.authorId, role: 'RECEPTION' },
  requestId: null,
  ip: null,
  userAgent: null,
});

describe('recall: ciclo de intentos en la BD (int, DX-465)', () => {
  let a: Clinic;
  let b: Clinic;

  beforeAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
  }, 120_000);

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.deleteMany({
      where: { id: { in: [a?.authorId, b?.authorId].filter(Boolean) } },
    });
    await Promise.all([raw.$disconnect(), prisma.$disconnect()]);
  });

  it('un intento lo oculta los días de la sede desde el día del intento y vuelve ese día, con el contador', async () => {
    const r = await seedRecall(a);
    const { contact } = await record(a, r.recallId, {
      channel: 'CALL',
      outcome: 'NO_ANSWER',
    });
    const day = await contactDay(r.recallId);
    expect(civilDateIn(contact.createdAt, ZONE)).toBe(day);
    const state = await raw.patientRecall.findUniqueOrThrow({
      where: { id: r.recallId },
    });
    expect(state).toMatchObject({
      attemptCount: 1,
      lastAttemptAt: contact.createdAt,
      callbackOn: null,
      skipUntil: null,
      cycleDueAt: DAY(r.dueAt),
    });
    // Sin ajustes de la sede: 7 días.
    expect((await listIds(a, noonOf(day))).has(r.recallId)).toBe(false);
    expect(
      (await listIds(a, noonOf(addCivilDays(day, 6)))).has(r.recallId),
    ).toBe(false);
    expect(
      (await listIds(a, noonOf(day), { includeContacted: true })).get(
        r.recallId,
      ),
    ).toEqual({ attempts: 1, hiddenUntil: addCivilDays(day, 7) });
    expect(
      (await listIds(a, noonOf(addCivilDays(day, 7)))).get(r.recallId),
    ).toEqual({ attempts: 1, hiddenUntil: null });
  });

  it('los ajustes de la sede se aplican al leer: 2 días y tope de 2', async () => {
    const r = await seedRecall(a, { lastDoneAt: '2025-02-01' });
    await raw.locationRecallSettings.create({
      data: {
        tenantId: a.tenantId,
        locationId: a.otherLocationId,
        hideDays: 2,
        maxAttempts: 2,
      },
    });
    await raw.patientRecall.update({
      where: { id: r.recallId },
      data: { locationId: a.otherLocationId },
    });
    await record(a, r.recallId, { channel: 'CALL', outcome: 'LEFT_MESSAGE' });
    const day = await contactDay(r.recallId);
    expect(
      (await listIds(a, noonOf(addCivilDays(day, 2)))).get(r.recallId),
    ).toEqual({ attempts: 1, hiddenUntil: null });
    await record(a, r.recallId, {
      channel: 'WHATSAPP_LINK',
      outcome: 'NO_ANSWER',
    });
    // Dos intentos con tope 2: agotado, fuera por defecto e incluso con
    // «Incluir contactados»; solo en «Intentos agotados».
    const later = noonOf(addCivilDays(await contactDay(r.recallId), 30));
    expect((await listIds(a, later)).has(r.recallId)).toBe(false);
    expect(
      (await listIds(a, later, { includeContacted: true })).has(r.recallId),
    ).toBe(false);
    expect(
      (await listIds(a, later, { exhausted: true })).get(r.recallId),
    ).toEqual({ attempts: 2, hiddenUntil: null });
    // Subir el tope lo devuelve a la lista al instante.
    await raw.locationRecallSettings.update({
      where: {
        tenantId_locationId: {
          tenantId: a.tenantId,
          locationId: a.otherLocationId,
        },
      },
      data: { maxAttempts: 3 },
    });
    expect((await listIds(a, later)).get(r.recallId)).toEqual({
      attempts: 2,
      hiddenUntil: null,
    });
  });

  it('«Llamar luego» con fecha: oculto hasta esa fecha; guardada en el contacto', async () => {
    const r = await seedRecall(a);
    const today = civilDateIn(new Date(), ZONE);
    const callbackOn = addCivilDays(today, 20);
    const { contact } = await record(
      a,
      r.recallId,
      { channel: 'CALL', outcome: 'CALL_BACK', callbackOn },
      noonOf(today),
    );
    expect(contact.callbackOn).toBe(callbackOn);
    expect(
      (await listIds(a, noonOf(addCivilDays(today, 19)))).has(r.recallId),
    ).toBe(false);
    expect((await listIds(a, noonOf(callbackOn))).get(r.recallId)).toEqual({
      attempts: 1,
      hiddenUntil: null,
    });
  });

  it('«Rechaza»: contador a 0, no sale hasta el vencimiento siguiente; no toca la pausa clínica', async () => {
    const r = await seedRecall(a, { lastDoneAt: '2026-01-15' });
    await record(a, r.recallId, { channel: 'CALL', outcome: 'NO_ANSWER' });
    await record(a, r.recallId, { channel: 'CALL', outcome: 'DECLINED' });
    const state = await raw.patientRecall.findUniqueOrThrow({
      where: { id: r.recallId },
    });
    expect(state).toMatchObject({
      attemptCount: 0,
      skipUntil: DAY('2027-01-15'),
      disabledUntil: null,
      disabledReason: null,
    });
    expect((await listIds(a, noonOf('2027-01-14'))).has(r.recallId)).toBe(
      false,
    );
    expect((await listIds(a, noonOf('2027-01-15'))).get(r.recallId)).toEqual({
      attempts: 0,
      hiddenUntil: null,
    });
  });

  it('un vencimiento nuevo (se fijó otro control) empieza el ciclo de cero sin tocar la fila', async () => {
    const r = await seedRecall(a);
    for (let i = 0; i < 3; i += 1) {
      await record(a, r.recallId, { channel: 'CALL', outcome: 'NO_ANSWER' });
    }
    const day = await contactDay(r.recallId);
    expect(
      (
        await listIds(a, noonOf(addCivilDays(day, 30)), { exhausted: true })
      ).has(r.recallId),
    ).toBe(true);
    await raw.patientRecall.update({
      where: { id: r.recallId },
      data: { manualDoneAt: DAY('2025-03-01'), lastDoneAt: DAY('2025-03-01') },
    });
    expect(
      (await listIds(a, noonOf(addCivilDays(day, 30)))).get(r.recallId),
    ).toEqual({ attempts: 0, hiddenUntil: null });
  });

  it('«Número equivocado» marca el teléfono (una vez); cambiar el número la quita en la BD; «Ya está corregido» también', async () => {
    const r = await seedRecall(a);
    await record(a, r.recallId, { channel: 'CALL', outcome: 'WRONG_NUMBER' });
    const flagged = await raw.patient.findUniqueOrThrow({
      where: { id: r.patientId },
      select: { phoneReviewFlaggedAt: true, phoneReviewFlaggedById: true },
    });
    expect(flagged.phoneReviewFlaggedById).toBe(a.authorId);
    expect(flagged.phoneReviewFlaggedAt).toBeInstanceOf(Date);
    await record(a, r.recallId, { channel: 'CALL', outcome: 'WRONG_NUMBER' });
    await expect(
      raw.patient.findUniqueOrThrow({
        where: { id: r.patientId },
        select: { phoneReviewFlaggedAt: true },
      }),
    ).resolves.toEqual({ phoneReviewFlaggedAt: flagged.phoneReviewFlaggedAt });
    const recalls = await inClinic(a, () =>
      repository.patientRecalls(r.patientId, new Date()),
    );
    expect(recalls.phoneReview).toEqual({
      flaggedAt: flagged.phoneReviewFlaggedAt,
      flaggedBy: { id: a.authorId, fullName: 'Recepción Chacao' },
    });
    // La lista lo marca.
    const page = await inClinic(a, () =>
      new ListDueRecallsUseCase(repository, () => new Date()).execute({
        includeContacted: true,
        pageSize: 100,
      }),
    );
    expect(page.items.find((i) => i.recallId === r.recallId)?.phoneReview).toBe(
      true,
    );
    // El trigger de dx_phone_e164_stale la anula al cambiar el teléfono.
    await raw.patient.update({
      where: { id: r.patientId },
      data: { phone: '+58 414 555 0202' },
    });
    await expect(
      raw.patient.findUniqueOrThrow({
        where: { id: r.patientId },
        select: { phoneReviewFlaggedAt: true, phoneReviewFlaggedById: true },
      }),
    ).resolves.toEqual({
      phoneReviewFlaggedAt: null,
      phoneReviewFlaggedById: null,
    });
    // «Ya está corregido»: con marca la quita y audita; sin marca, nada.
    await record(a, r.recallId, { channel: 'CALL', outcome: 'WRONG_NUMBER' });
    await expect(
      inClinic(a, () => repository.clearPhoneReview(r.patientId, actorOf(a))),
    ).resolves.toBe(true);
    await expect(
      inClinic(a, () => repository.clearPhoneReview(r.patientId, actorOf(a))),
    ).resolves.toBe(false);
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'PATIENT',
        resourceId: r.patientId,
        action: 'UPDATE',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      reason: 'PHONE_REVIEW_CLEARED',
      changedFields: ['phoneReviewFlaggedAt'],
    });
    // Otra clínica: el paciente no existe.
    await expect(
      inClinic(b, () => repository.clearPhoneReview(r.patientId, actorOf(b))),
    ).resolves.toBeNull();
  });

  it('dos intentos a la vez sobre el mismo recall no pierden ninguno (fila bloqueada)', async () => {
    const r = await seedRecall(a);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        record(a, r.recallId, { channel: 'CALL', outcome: 'NO_ANSWER' }),
      ),
    );
    await expect(
      raw.patientRecall.findUniqueOrThrow({
        where: { id: r.recallId },
        select: { attemptCount: true },
      }),
    ).resolves.toEqual({ attemptCount: 4 });
  });

  it('el lote es todo o nada: un recall de otra clínica da 404 y no escribe ninguno; si no, uno por recall con su evento', async () => {
    const r1 = await seedRecall(a);
    const r2 = await seedRecall(a);
    const foreign = await seedRecall(b);
    const refs = await inClinic(a, () =>
      repository.findRecalls([r1.recallId, r2.recallId, foreign.recallId]),
    );
    expect(refs.map((x) => x.id).sort()).toEqual(
      [r1.recallId, r2.recallId].sort(),
    );
    // Aunque se le pase una referencia de B, el bloqueo (bajo RLS) no la ve.
    await expect(
      inClinic(a, () =>
        repository.createContactsBatch(
          {
            recalls: [
              ...refs,
              {
                ...refs[0],
                id: foreign.recallId,
                patientId: foreign.patientId,
              },
            ],
            channel: 'CALL',
            outcome: 'NO_ANSWER',
            note: 'Sin respuesta',
            callbackOn: null,
            authorId: a.authorId,
          },
          actorOf(a),
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      raw.recallContact.count({
        where: { recallId: { in: [r1.recallId, r2.recallId] } },
      }),
    ).resolves.toBe(0);
    const out = await inClinic(a, () =>
      repository.createContactsBatch(
        {
          recalls: refs,
          channel: 'WHATSAPP_LINK',
          outcome: 'LEFT_MESSAGE',
          note: 'Mensaje de voz',
          callbackOn: null,
          authorId: a.authorId,
        },
        actorOf(a),
      ),
    );
    expect(out.map((c) => c.recallId)).toEqual(refs.map((x) => x.id));
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'RECALL_CONTACT',
        resourceId: { in: out.map((c) => c.id) },
      },
    });
    expect(events).toHaveLength(2);
    for (const e of events) {
      expect(e.action).toBe('CREATE');
      expect(e.metadata).toMatchObject({ reason: 'RECALL_CONTACT_BATCH' });
      // Nunca la nota.
      expect(JSON.stringify(e.metadata)).not.toContain('Mensaje de voz');
    }
    expect(new Set(events.map((e) => e.patientId))).toEqual(
      new Set([r1.patientId, r2.patientId]),
    );
    await expect(
      raw.patientRecall.findMany({
        where: { id: { in: [r1.recallId, r2.recallId] } },
        select: { attemptCount: true },
      }),
    ).resolves.toEqual([{ attemptCount: 1 }, { attemptCount: 1 }]);
  });

  describe('cierre al agendar (D6)', () => {
    const book = (
      c: Clinic,
      patientId: string,
      appointmentId: string,
      appointmentTypeId: string | null,
      withUser: boolean,
    ) =>
      inClinic(c, () =>
        prisma.runWithTenant((tx) =>
          recallOnAppointmentBookedInTx(tx, {
            tenantId: c.tenantId,
            patientId,
            appointmentId,
            appointmentTypeId,
            actor: withUser
              ? {
                  actor: { userId: c.authorId, role: 'RECEPTION' },
                  locationId: c.locationId,
                  requestId: null,
                  ip: null,
                  userAgent: null,
                }
              : null,
          }),
        ),
      );

    it('con usuario: «Agendó» con la cita (canal del último intento), su evento y el ciclo cerrado; una segunda vez, nada', async () => {
      const r = await seedRecall(a);
      await record(a, r.recallId, {
        channel: 'WHATSAPP_LINK',
        outcome: 'NO_ANSWER',
      });
      await record(a, r.recallId, {
        channel: 'WHATSAPP_LINK',
        outcome: 'WILL_BOOK',
      });
      const appt = await appointmentOf(a, r.patientId, a.appointmentTypeId);
      await expect(
        book(a, r.patientId, appt, a.appointmentTypeId, true),
      ).resolves.toBe(1);
      const booked = await raw.recallContact.findMany({
        where: { recallId: r.recallId, outcome: 'BOOKED' },
      });
      expect(booked).toHaveLength(1);
      expect(booked[0]).toMatchObject({
        appointmentId: appt,
        channel: 'WHATSAPP_LINK',
        authorId: a.authorId,
        locationId: a.locationId,
      });
      await expect(
        raw.patientRecall.findUniqueOrThrow({
          where: { id: r.recallId },
          select: {
            attemptCount: true,
            lastAttemptAt: true,
            callbackOn: true,
            skipUntil: true,
            cycleDueAt: true,
          },
        }),
      ).resolves.toEqual({
        attemptCount: 0,
        lastAttemptAt: null,
        callbackOn: null,
        skipUntil: null,
        cycleDueAt: DAY(r.dueAt),
      });
      const events = await raw.auditEvent.findMany({
        where: { resourceType: 'RECALL_CONTACT', resourceId: booked[0].id },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'CREATE',
        actorUserId: a.authorId,
        patientId: r.patientId,
      });
      expect(events[0].metadata).toMatchObject({
        reason: 'RECALL_BOOKED_BY_APPOINTMENT',
        params: { appointmentId: appt, recallId: r.recallId },
      });
      // Repetir (otra petición con la misma cita): sin segundo «Agendó».
      await book(a, r.patientId, appt, a.appointmentTypeId, true);
      await expect(
        raw.recallContact.count({
          where: { recallId: r.recallId, outcome: 'BOOKED' },
        }),
      ).resolves.toBe(1);
      // La web registra después su «Agendó»: el existente, sin otro.
      const replay = await record(a, r.recallId, {
        channel: 'CALL',
        outcome: 'BOOKED',
        appointmentId: appt,
      });
      expect(replay).toMatchObject({
        replayed: true,
        contact: { id: booked[0].id, channel: 'WHATSAPP_LINK' },
      });
    });

    it('el índice único parcial impide dos «Agendó» de la misma cita en el mismo recall', async () => {
      const r = await seedRecall(a);
      const appt = await appointmentOf(a, r.patientId, null);
      const row = {
        tenantId: a.tenantId,
        recallId: r.recallId,
        patientId: r.patientId,
        channel: 'CALL' as const,
        outcome: 'BOOKED' as const,
        appointmentId: appt,
        authorId: a.authorId,
      };
      await raw.recallContact.create({ data: row });
      await expect(
        raw.recallContact.create({ data: row }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('sin usuario (reserva online, oferta aceptada): solo cierra el ciclo, sin contacto ni evento', async () => {
      const r = await seedRecall(a);
      await record(a, r.recallId, { channel: 'CALL', outcome: 'NO_ANSWER' });
      await record(a, r.recallId, { channel: 'CALL', outcome: 'NO_ANSWER' });
      const before = await raw.auditEvent.count({
        where: { tenantId: a.tenantId },
      });
      const appt = await appointmentOf(a, r.patientId, a.appointmentTypeId);
      await expect(
        book(a, r.patientId, appt, a.appointmentTypeId, false),
      ).resolves.toBe(1);
      await expect(
        raw.recallContact.count({
          where: { recallId: r.recallId, outcome: 'BOOKED' },
        }),
      ).resolves.toBe(0);
      await expect(
        raw.auditEvent.count({ where: { tenantId: a.tenantId } }),
      ).resolves.toBe(before);
      await expect(
        raw.patientRecall.findUniqueOrThrow({
          where: { id: r.recallId },
          select: { attemptCount: true, lastAttemptAt: true },
        }),
      ).resolves.toEqual({ attemptCount: 0, lastAttemptAt: null });
    });

    it('no cierra: otro tipo de cita, sin tipo, un recall de un tipo sin enlace ni uno que aún no está en su ciclo', async () => {
      const r = await seedRecall(a);
      await record(a, r.recallId, { channel: 'CALL', outcome: 'NO_ANSWER' });
      const checkup = await seedRecall(a, { typeId: a.checkupTypeId });
      // Vence dentro de más de 60 días y sin intentos: no se toca.
      const future = await seedRecall(a, {
        lastDoneAt: addCivilDays(civilDateIn(new Date(), ZONE), -30),
      });
      const otherType = await raw.appointmentType.create({
        data: {
          tenantId: a.tenantId,
          name: `Ortodoncia ${randomUUID().slice(0, 4)}`,
          durationMinutes: 30,
          color: '#F97316',
        },
      });
      const appt = await appointmentOf(a, r.patientId, otherType.id);
      await expect(
        book(a, r.patientId, appt, otherType.id, true),
      ).resolves.toBe(0);
      await expect(book(a, r.patientId, appt, null, true)).resolves.toBe(0);
      const appt2 = await appointmentOf(
        a,
        checkup.patientId,
        a.appointmentTypeId,
      );
      await expect(
        book(a, checkup.patientId, appt2, a.appointmentTypeId, true),
      ).resolves.toBe(0);
      const appt3 = await appointmentOf(
        a,
        future.patientId,
        a.appointmentTypeId,
      );
      await expect(
        book(a, future.patientId, appt3, a.appointmentTypeId, true),
      ).resolves.toBe(0);
      await expect(
        raw.patientRecall.findUniqueOrThrow({
          where: { id: r.recallId },
          select: { attemptCount: true },
        }),
      ).resolves.toEqual({ attemptCount: 1 });
      await expect(
        raw.recallContact.count({
          where: {
            recallId: { in: [checkup.recallId, future.recallId] },
          },
        }),
      ).resolves.toBe(0);
    });
  });

  it('location_recall_settings: RLS FORCE, sin DELETE para la app, y B no ve los de A', async () => {
    await raw.locationRecallSettings.upsert({
      where: {
        tenantId_locationId: { tenantId: a.tenantId, locationId: a.locationId },
      },
      create: { tenantId: a.tenantId, locationId: a.locationId, hideDays: 5 },
      update: { hideDays: 5 },
    });
    const [rls] = await raw.$queryRaw<
      { relrowsecurity: boolean; relforcerowsecurity: boolean }[]
    >`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'location_recall_settings'`;
    expect(rls).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    await expect(
      inClinic(b, () =>
        prisma.runWithTenant((tx) =>
          tx.locationRecallSettings.count({
            where: { locationId: a.locationId },
          }),
        ),
      ),
    ).resolves.toBe(0);
    const listedByB = await inClinic(b, () => repository.listSettings());
    expect(listedByB.map((s) => s.locationId)).not.toContain(a.locationId);
    await expect(
      inClinic(a, () =>
        prisma.runWithTenant(
          (tx) =>
            tx.$executeRaw`DELETE FROM "location_recall_settings" WHERE "tenantId" = ${a.tenantId}::uuid`,
        ),
      ),
    ).rejects.toThrow(/permission denied|permiso denegado/);
    // B no guarda en una sede de A (404 en el caso de uso).
    await expect(
      inClinic(b, () =>
        repository.saveSettings(
          a.locationId,
          { hideDays: 9, maxAttempts: 9 },
          actorOf(b),
        ),
      ),
    ).resolves.toBeNull();
  });

  it('el relleno de 20270121140100 deja el estado desde los contactos del ciclo (y es idempotente)', async () => {
    const insert = (recallId: string, patientId: string, outcome: string) =>
      raw.recallContact.create({
        data: {
          tenantId: a.tenantId,
          recallId,
          patientId,
          channel: 'CALL',
          outcome: outcome as 'NO_ANSWER',
          authorId: a.authorId,
        },
      });
    const plain = await seedRecall(a);
    await insert(plain.recallId, plain.patientId, 'NO_ANSWER');
    await insert(plain.recallId, plain.patientId, 'CALL_BACK');
    const declined = await seedRecall(a, { lastDoneAt: '2025-02-01' });
    await insert(declined.recallId, declined.patientId, 'NO_ANSWER');
    await insert(declined.recallId, declined.patientId, 'DECLINED');
    const afterDecline = await seedRecall(a, { lastDoneAt: '2025-03-01' });
    await insert(afterDecline.recallId, afterDecline.patientId, 'DECLINED');
    await insert(afterDecline.recallId, afterDecline.patientId, 'NO_ANSWER');
    // Un contacto de antes de la base es de otro ciclo: no cuenta.
    const old = await seedRecall(a, {
      lastDoneAt: civilDateIn(new Date(), ZONE),
    });
    await insert(old.recallId, old.patientId, 'NO_ANSWER');
    await raw.patientRecall.update({
      where: { id: old.recallId },
      data: {
        lastDoneAt: DAY(addCivilDays(civilDateIn(new Date(), ZONE), 2)),
        manualDoneAt: DAY(addCivilDays(civilDateIn(new Date(), ZONE), 2)),
      },
    });
    const sql = readFileSync(
      join(
        __dirname,
        '../prisma/migrations/20270121140100_dx465_recall_attempts_backfill/migration.sql',
      ),
      'utf8',
    );
    for (let run = 0; run < 2; run += 1) {
      await raw.$executeRawUnsafe(sql);
      const rows = await raw.patientRecall.findMany({
        where: {
          id: {
            in: [
              plain.recallId,
              declined.recallId,
              afterDecline.recallId,
              old.recallId,
            ],
          },
        },
        select: {
          id: true,
          attemptCount: true,
          lastAttemptAt: true,
          skipUntil: true,
          cycleDueAt: true,
          dueAt: true,
        },
      });
      const by = new Map(rows.map((x) => [x.id, x]));
      expect(by.get(plain.recallId)).toMatchObject({
        attemptCount: 2,
        skipUntil: null,
        cycleDueAt: DAY(plain.dueAt),
      });
      expect(by.get(plain.recallId)!.lastAttemptAt).toBeInstanceOf(Date);
      expect(by.get(declined.recallId)).toMatchObject({
        attemptCount: 0,
        skipUntil: DAY('2026-02-01'),
      });
      expect(by.get(declined.recallId)!.lastAttemptAt).toBeInstanceOf(Date);
      expect(by.get(afterDecline.recallId)).toMatchObject({
        attemptCount: 1,
        skipUntil: null,
      });
      expect(by.get(old.recallId)).toMatchObject({
        attemptCount: 0,
        lastAttemptAt: null,
        cycleDueAt: null,
      });
    }
  });
});
