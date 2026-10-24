import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
  STAFF_CANCELLATION,
} from './support/e2e-fixtures';

// DX-210 en HTTP real: «Ocupar este hueco». Cancelar una cita de 30 min →
// candidatos del hueco (URGENT antes que NORMAL; ni el de 60 min, ni el de
// otra sede, ni el de otra clínica, ni quien canceló; la cita marcada de
// dentro de 3 semanas sí, la del mismo día no), roles (DENTIST solo su
// columna, ASSISTANT 403), ofertas con tope de 2 por día y baja de WhatsApp
// (DX-128), asignar un pendiente y adelantar una cita marcada, con 409 en
// español cuando otro ya ocupó el hueco.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const DAY_MS = 24 * 60 * 60 * 1000;
const BOGOTA_MS = 5 * 60 * 60 * 1000;

function nextTuesday(): string {
  let t = Date.now() - BOGOTA_MS + 7 * DAY_MS;
  while (new Date(t).getUTCDay() !== 2) t += DAY_MS;
  return new Date(t).toISOString().slice(0, 10);
}
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
/** Hora de pared de Bogotá (UTC−5 fijo) como instante ISO. */
function local(day: string, hhmm: string): string {
  return new Date(`${day}T${hhmm}:00-05:00`).toISOString();
}

const TUE = nextTuesday();
const IN_3_WEEKS = addDays(TUE, 21);

interface Member {
  userId: string;
  token: string;
}
interface Body {
  id: string;
  [key: string]: unknown;
}
interface Candidate {
  kind: string;
  patientId: string;
  patientFirstName: string;
  waitlistEntryId: string | null;
  appointmentId: string | null;
  priority: string;
  whatsappPhone: string | null;
  whatsappBlocked: boolean;
  whatsappBlockedReason: string | null;
  pendingOfferId: string | null;
  offersToday: number;
  offeredForSlot: boolean;
  currentAppointment: { start: string } | null;
}
interface CandidatesView {
  items: Candidate[];
  offerCap: number;
  timeZone: string;
}

describe('Hueco libre → candidatos (e2e, DX-210)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  let dentist: Member;
  let dentist2: Member;
  let reception: Member;
  let assistant: Member;
  let locationId: string;
  let northId: string;
  const patient: Record<string, string> = {};
  const entry: Record<string, string> = {};
  let farAppointmentId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  async function member(role: ClinicRole): Promise<Member> {
    const m = await seedMember(raw, clinic, role);
    return {
      userId: m.userId,
      token: await loginAs(app, clinic.host, m.email),
    };
  }

  async function createPatient(c: Clinic, doc: string, firstName: string) {
    const res = await as(api().post('/api/v1/patients'), c.adminToken, c.host)
      .send({
        firstName,
        lastName: 'Hueco',
        docType: 'CC',
        docNumber: doc,
        sex: 'F',
        phone: '3101234567',
      })
      .expect(201);
    return (res.body as Body).id;
  }

  function book(
    patientId: string,
    day: string,
    hhmm: string,
    extra: Record<string, unknown> = {},
    minutes = 30,
  ) {
    const start = local(day, hhmm);
    return as(api().post('/api/v1/appointments'), reception.token).send({
      patientId,
      providerId: dentist.userId,
      start,
      end: new Date(Date.parse(start) + minutes * 60_000).toISOString(),
      ...extra,
    });
  }

  async function pending(
    patientId: string,
    body: Record<string, unknown> = {},
    c = clinic,
    token = reception.token,
  ) {
    const res = await as(api().post('/api/v1/waitlist'), token, c.host)
      .send({ patientId, durationMinutes: 30, ...body })
      .expect(201);
    return (res.body as Body).id;
  }

  const SLOT = { start: local(TUE, '10:00'), end: local(TUE, '10:30') };

  function candidates(
    token = reception.token,
    query: Record<string, string> = {
      ...SLOT,
      providerId: '',
    },
    loc = locationId,
    host = clinic.host,
  ) {
    const q = { ...query };
    if (q.providerId === '') q.providerId = dentist.userId;
    return as(
      api().get(`/api/v1/appointments/openings/${loc}/candidates`).query(q),
      token,
      host,
    );
  }

  function offer(body: Record<string, unknown>, token = reception.token) {
    return as(
      api().post(`/api/v1/appointments/openings/${locationId}/offers`),
      token,
    ).send({
      slotStart: SLOT.start,
      slotEnd: SLOT.end,
      providerId: dentist.userId,
      ...body,
    });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx210-e2e');
    other = await registerClinic(app, 'dx210-e2e-otra');
    dentist = await member(ClinicRole.DENTIST);
    reception = await member(ClinicRole.RECEPTION);
    assistant = await member(ClinicRole.ASSISTANT);
    const d2 = await raw.user.create({
      data: {
        email: 'dentista2@dx210-e2e.test',
        passwordHash: (
          await raw.user.findFirstOrThrow({ where: { id: dentist.userId } })
        ).passwordHash,
        fullName: 'Dra. Segunda',
        emailVerifiedAt: new Date(),
      },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: clinic.tenantId,
        userId: d2.id,
        role: ClinicRole.DENTIST,
      },
    });
    dentist2 = {
      userId: d2.id,
      token: await loginAs(app, clinic.host, d2.email),
    };

    await as(api().put('/api/v1/locations/schedule'), clinic.adminToken)
      .send({
        timezone: 'America/Bogota',
        ranges: [1, 2, 3, 4, 5].flatMap((weekday) => [
          { weekday, startMinute: 540, endMinute: 780 },
          { weekday, startMinute: 900, endMinute: 1140 },
        ]),
      })
      .expect(200);
    const locations = await as(
      api().get('/api/v1/locations'),
      clinic.adminToken,
    ).expect(200);
    locationId = (locations.body as Body[])[0].id;
    const north = await as(api().post('/api/v1/locations'), clinic.adminToken)
      .send({ name: 'Sede Norte' })
      .expect(201);
    northId = (north.body as Body).id;

    for (const [i, name] of [
      'Ana',
      'Berta',
      'Carla',
      'Dora',
      'Elena',
      'Fani',
      'Gabi',
    ].entries()) {
      patient[name] = await createPatient(clinic, `21000${i}`, name);
    }
    patient.Otra = await createPatient(other, '210900', 'Otra');
    // DX-128: Ana y Berta dieron en persona el permiso de WhatsApp; el resto
    // no (sin él no se les ofrece por WhatsApp: se les llama).
    await raw.patient.updateMany({
      where: { id: { in: [patient.Ana, patient.Berta] } },
      data: { whatsappOptInAt: new Date(), whatsappOptInSource: 'IN_PERSON' },
    });

    // Pendientes: Ana URGENT y Berta NORMAL (30 min, sede principal), Carla
    // de 60 min, Dora en la Sede Norte y Otra en la otra clínica.
    entry.Berta = await pending(patient.Berta);
    entry.Ana = await pending(patient.Ana, { priority: 'URGENT' });
    entry.Carla = await pending(patient.Carla, { durationMinutes: 60 });
    entry.Dora = await pending(patient.Dora, { locationId: northId });
    await pending(patient.Otra, {}, other, other.adminToken);

    // Citas marcadas «Adelantar si hay hueco»: Elena dentro de 3 semanas,
    // Fani el mismo día del hueco.
    const far = await book(patient.Elena, IN_3_WEEKS, '09:00', {
      wantsEarlier: true,
    }).expect(201);
    farAppointmentId = (far.body as Body).id;
    expect((far.body as Body).wantsEarlier).toBe(true);
    await book(patient.Fani, TUE, '16:00', { wantsEarlier: true }).expect(201);

    // Gabi cancela su cita de 30 min de las 10:00 con la Dra.: queda el hueco.
    const gabi = await book(patient.Gabi, TUE, '10:00').expect(201);
    await as(
      api().patch(`/api/v1/appointments/${(gabi.body as Body).id}`),
      reception.token,
    )
      .send({ status: 'CANCELLED', ...STAFF_CANCELLATION })
      .expect(200);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('candidatos del hueco cancelado: URGENT, NORMAL y la cita de dentro de 3 semanas; nadie más', async () => {
    const res = await candidates().expect(200);
    const view = res.body as CandidatesView;
    expect(view.items.map((c) => c.patientFirstName)).toEqual([
      'Ana',
      'Berta',
      'Elena',
    ]);
    expect(view).toMatchObject({ offerCap: 2, timeZone: 'America/Bogota' });
    expect(view.items[0]).toMatchObject({
      kind: 'WAITLIST',
      priority: 'URGENT',
      waitlistEntryId: entry.Ana,
      whatsappPhone: '573101234567',
      whatsappBlocked: false,
      whatsappBlockedReason: null,
      offersToday: 0,
      pendingOfferId: null,
    });
    expect(view.items[2]).toMatchObject({
      kind: 'APPOINTMENT',
      appointmentId: farAppointmentId,
      currentAppointment: { start: local(IN_3_WEEKS, '09:00') },
    });
  });

  it('roles: ASSISTANT 403; DENTIST solo su columna; la otra clínica no ve la sede', async () => {
    await candidates(assistant.token).expect(403);
    await candidates(dentist.token).expect(200);
    const foreign = await candidates(dentist2.token).expect(403);
    expect((foreign.body as { message: string }).message).toMatch(
      /tu propia agenda/,
    );
    await candidates(dentist.token, SLOT as Record<string, string>).expect(403);
    await candidates(
      other.adminToken,
      { ...SLOT, providerId: dentist.userId },
      locationId,
      other.host,
    ).expect(404);
    // Un paciente de otra clínica no existe aquí (RLS): 404 al ofrecerle.
    await offer({
      patientId: patient.Otra,
      channel: 'PHONE',
      outcome: 'NO_ANSWER',
    }).expect(404);
    await candidates(reception.token, {
      start: SLOT.end,
      end: SLOT.start,
      providerId: dentist.userId,
    }).expect(400);
    await offer(
      { patientId: patient.Ana, channel: 'PHONE', outcome: 'NO_ANSWER' },
      dentist.token,
    ).expect(403);
    await offer(
      { patientId: patient.Ana, channel: 'PHONE', outcome: 'NO_ANSWER' },
      assistant.token,
    ).expect(403);
  });

  it('ofrecer: por WhatsApp y llamada, tope de 2 al día (409) y «aviso enviado»', async () => {
    const wa = await offer({
      patientId: patient.Ana,
      waitlistEntryId: entry.Ana,
      channel: 'WA_ME',
    }).expect(201);
    expect(wa.body).toMatchObject({
      outcome: 'PENDING',
      offersToday: 1,
      offerCap: 2,
    });
    await offer({
      patientId: patient.Ana,
      waitlistEntryId: entry.Ana,
      channel: 'PHONE',
      outcome: 'NO_ANSWER',
    }).expect(201);
    const third = await offer({
      patientId: patient.Ana,
      channel: 'WA_ME',
    }).expect(409);
    expect((third.body as { message: string }).message).toBe(
      'Ya se le ofrecieron 2 huecos hoy',
    );

    const view = (await candidates().expect(200)).body as CandidatesView;
    // Respuesta al WhatsApp: el panel la anota sobre `pendingOfferId`.
    const offerId = (wa.body as Body).id;
    expect(view.items[0]).toMatchObject({
      patientFirstName: 'Ana',
      offersToday: 2,
      offeredForSlot: true,
      pendingOfferId: offerId,
    });
    await as(
      api().patch(`/api/v1/appointments/openings/offers/${offerId}`),
      reception.token,
    )
      .send({ outcome: 'DECLINED' })
      .expect(200);
    await as(
      api().patch(`/api/v1/appointments/openings/offers/${offerId}`),
      reception.token,
    )
      .send({ outcome: 'ACCEPTED' })
      .expect(409);
    const after = (await candidates().expect(200)).body as CandidatesView;
    expect(after.items[0].pendingOfferId).toBeNull();

    await expect(
      raw.auditEvent.count({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'WAITLIST_OFFER',
          patientId: patient.Ana,
        },
      }),
    ).resolves.toBe(3);
  });

  it('baja de WhatsApp (DX-128): bloqueado en la lista y 409 al ofrecer; por teléfono sí', async () => {
    await raw.patient.update({
      where: { id: patient.Berta },
      data: { reminderOptOutAt: new Date(), reminderOptOutSource: 'STAFF' },
    });
    const view = (await candidates().expect(200)).body as CandidatesView;
    expect(view.items.find((c) => c.patientId === patient.Berta)).toMatchObject(
      {
        whatsappBlocked: true,
        whatsappBlockedReason: 'OPTED_OUT',
        whatsappPhone: null,
      },
    );
    const res = await offer({
      patientId: patient.Berta,
      channel: 'WA_ME',
    }).expect(409);
    expect((res.body as { message: string }).message).toMatch(/Llámalo/);
    await offer({
      patientId: patient.Berta,
      waitlistEntryId: entry.Berta,
      channel: 'PHONE',
      outcome: 'ACCEPTED',
    }).expect(201);
  });

  it('sin el permiso de WhatsApp (DX-128): bloqueado en la lista y 409 al ofrecer por WhatsApp', async () => {
    const view = (await candidates().expect(200)).body as CandidatesView;
    expect(view.items.find((c) => c.patientId === patient.Elena)).toMatchObject(
      {
        whatsappBlocked: true,
        whatsappBlockedReason: 'NO_OPT_IN',
        whatsappPhone: null,
      },
    );
    const res = await offer({
      patientId: patient.Elena,
      appointmentId: farAppointmentId,
      channel: 'WA_ME',
    }).expect(409);
    expect((res.body as { message: string }).message).toBe(
      'Este paciente no ha dado permiso para escribirle por WhatsApp. Llámalo.',
    );
  });

  it('asignar un pendiente reutiliza waitlist/:id/schedule; el segundo al mismo hueco recibe 409 en español y sale de la lista el asignado', async () => {
    await as(
      api().post(`/api/v1/waitlist/${entry.Berta}/schedule`),
      reception.token,
    )
      .send({ providerId: dentist.userId, start: SLOT.start })
      .expect(201);
    const late = await as(
      api().post(`/api/v1/waitlist/${entry.Ana}/schedule`),
      reception.token,
    )
      .send({ providerId: dentist.userId, start: SLOT.start })
      .expect(409);
    expect((late.body as { message: string }).message).toBe(
      'El profesional ya tiene una cita en ese horario',
    );
    const view = (await candidates().expect(200)).body as CandidatesView;
    expect(view.items.map((c) => c.patientFirstName)).toEqual(['Ana', 'Elena']);
  });

  it('adelantar la cita marcada: se mueve al hueco, pierde la marca y su hora original queda libre', async () => {
    const slot = { start: local(TUE, '11:00'), end: local(TUE, '11:30') };
    await as(
      api().patch(`/api/v1/appointments/${farAppointmentId}/opening`),
      dentist.token,
    )
      .send({ start: slot.start })
      .expect(403);
    const moved = await as(
      api().patch(`/api/v1/appointments/${farAppointmentId}/opening`),
      reception.token,
    )
      .send({ start: slot.start, providerId: dentist.userId })
      .expect(200);
    expect(moved.body).toMatchObject({
      start: slot.start,
      end: slot.end,
      wantsEarlier: false,
    });
    const again = await as(
      api().patch(`/api/v1/appointments/${farAppointmentId}/opening`),
      reception.token,
    )
      .send({ start: local(TUE, '12:00') })
      .expect(409);
    expect((again.body as { message: string }).message).toMatch(
      /ya no está para adelantar/,
    );
    const day = await as(
      api()
        .get('/api/v1/appointments')
        .query({
          from: local(IN_3_WEEKS, '00:00'),
          to: local(addDays(IN_3_WEEKS, 1), '00:00'),
        }),
      reception.token,
    ).expect(200);
    expect(day.body).toEqual([]);
    const view = (
      await candidates(reception.token, {
        ...slot,
        providerId: dentist.userId,
      }).expect(200)
    ).body as CandidatesView;
    expect(view.items.some((c) => c.kind === 'APPOINTMENT')).toBe(false);
  });

  it('«Adelantar si hay hueco» en la cita: la asistente no la cambia; la doctora sí y queda auditado', async () => {
    const res = await book(patient.Carla, addDays(TUE, 7), '09:00').expect(201);
    const id = (res.body as Body).id;
    await as(api().patch(`/api/v1/appointments/${id}`), assistant.token)
      .send({ wantsEarlier: true })
      .expect(403);
    const marked = await as(
      api().patch(`/api/v1/appointments/${id}`),
      dentist.token,
    )
      .send({ wantsEarlier: true })
      .expect(200);
    expect(marked.body).toMatchObject({ wantsEarlier: true });
    await expect(
      raw.auditEvent.count({
        where: {
          tenantId: clinic.tenantId,
          resourceType: 'APPOINTMENT',
          resourceId: id,
          metadata: { path: ['reason'], equals: 'WANTS_EARLIER_ON' },
        },
      }),
    ).resolves.toBe(1);
    await as(api().post('/api/v1/appointments'), assistant.token)
      .send({
        patientId: patient.Dora,
        providerId: dentist.userId,
        start: local(addDays(TUE, 8), '09:00'),
        end: local(addDays(TUE, 8), '09:30'),
        wantsEarlier: true,
      })
      .expect(403);
  });
});
