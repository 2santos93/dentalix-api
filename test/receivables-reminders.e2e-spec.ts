import { INestApplication } from '@nestjs/common';
import {
  AppointmentStatus,
  CatalogKind,
  ClinicRole,
  Prisma,
  PrismaClient,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
  SEEDED_PASSWORD,
} from './support/e2e-fixtures';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { PasswordService } from '../src/shared/crypto/password.service';
import {
  locationBody,
  REGIONAL_CARACAS_FIXTURE,
} from './support/location-fixtures';

// DX-146 · «Por avisar hoy» de la cartera: tramos 7/30/60 con el día civil de
// America/Caracas, exclusiones (compromiso abierto, baja de avisos, pagado),
// roles, aislamiento entre clínicas, sedes permitidas, la marca «avisado» que
// no reaparece hoy y la política (solo ADMIN, auditada). Siembra de fechas
// pasadas por DIRECT_URL; todo lo demás, por la API.
//
// Relojes REALES a propósito: la marca «avisado» la fecha la BD (trigger de
// collection_notes) y el «hoy» de la lista tiene que ser el mismo. Las edades
// sembradas aguantan un día de más (una corrida que cruce la medianoche de
// Caracas): 10, 35 y 65 días siguen en el mismo tramo, y 3 sigue por debajo.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const CARACAS = 'America/Caracas';
const today = (): string => civilDateIn(new Date(), CARACAS);
/** 13:00 de Caracas de hace `n` días. */
const noonDaysAgo = (n: number): Date =>
  new Date(`${addCivilDays(today(), -n)}T17:00:00.000Z`);

interface ReminderRow {
  patient: { id: string; fullName: string; whatsApp: string | null };
  locationId: string | null;
  oldestAgeDays: number | null;
  currencies: { currency: string; debt: number }[];
  reminder: {
    stage: number;
    stageDays: number;
    noticesSent: number;
    lastNoticeOn: string | null;
  };
}

interface RemindersPage {
  asOf: string;
  policy: { days: number[]; maxNotices: number; minGapDays: number };
  items: ReminderRow[];
  total: number;
  excluded: { openPromise: number; optedOut: number };
}

const pageOf = (res: { body: unknown }): RemindersPage =>
  res.body as RemindersPage;
const idsOf = (res: { body: unknown }): string[] =>
  pageOf(res).items.map((i) => i.patient.id);

describe('Cartera › Por avisar hoy (e2e, DX-146)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let principal: string;
  let oeste: string;
  let catalogItemId: string;
  let receptionToken: string;
  let dentistToken: string;
  let assistantToken: string;
  let receptionOesteToken: string;

  // Pacientes de A (deuda sin cuotas: envejece desde la fecha del plan):
  //   tramo1   10 días, sede principal
  //   tramo2   35 días, sede principal
  //   tramo3   65 días, sede Oeste
  //   joven     3 días: aún no toca
  //   promesa  35 días con compromiso de pago abierto
  //   baja     35 días dado de baja de los avisos (DX-128)
  //   pagado   35 días, pagado entero
  let tramo1: string;
  let tramo2: string;
  let tramo3: string;
  let joven: string;
  let promesa: string;
  let baja: string;
  let pagado: string;

  let slot = 0;

  const server = () => app.getHttpServer();
  const api = (
    clinic: Clinic,
    verb: 'get' | 'post' | 'put',
    path: string,
    token = clinic.adminToken,
  ) =>
    request(server())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);

  async function patient(firstName: string, doc: string): Promise<string> {
    const row = await raw.patient.create({
      data: {
        tenantId: clinicA.tenantId,
        firstName,
        lastName: 'Aviso',
        docNumber: doc,
        phone: '0412 555 0101',
        countryCode: 'VE',
      },
      select: { id: true },
    });
    return row.id;
  }

  async function debtor(
    firstName: string,
    doc: string,
    daysAgo: number,
    locationId: string,
  ): Promise<{ id: string; planId: string }> {
    const id = await patient(firstName, doc);
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId: id,
        currency: 'USD',
        status: TreatmentPlanStatus.ACCEPTED,
        createdAt: noonDaysAgo(daysAgo),
        items: {
          create: {
            toothNumber: '11',
            catalogItemId,
            price: 120,
            status: TreatmentPlanItemStatus.ACCEPTED,
          },
        },
      },
      select: { id: true },
    });
    // La sede de la deuda es la de la última cita atendida (una por hora:
    // el profesional no se solapa).
    slot += 1;
    const start = new Date(noonDaysAgo(daysAgo).getTime() - slot * 3_600_000);
    await raw.appointment.create({
      data: {
        tenantId: clinicA.tenantId,
        locationId,
        patientId: id,
        providerId: clinicA.adminUserId,
        start,
        end: new Date(start.getTime() + 30 * 60 * 1000),
        status: AppointmentStatus.COMPLETED,
      },
    });
    return { id, planId: plan.id };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'avisos-a');
    clinicB = await registerClinic(app, 'avisos-b');

    const sedes = await api(clinicA, 'get', '/locations').expect(200);
    principal = (sedes.body as { id: string }[])[0].id;
    const created = await api(clinicA, 'post', '/locations')
      .send(locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Oeste' }))
      .expect(201);
    oeste = (created.body as { id: string }).id;

    const catalog = await api(clinicA, 'post', '/catalog/items')
      .send({
        code: 'AVISO',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Resina',
        color: '#2A2B3C',
        defaultPrice: 1,
      })
      .expect(201);
    catalogItemId = (catalog.body as { id: string }).id;

    for (const role of [
      ClinicRole.RECEPTION,
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
    ]) {
      const { email } = await seedMember(raw, clinicA, role);
      const token = await loginAs(app, clinicA.host, email);
      if (role === ClinicRole.RECEPTION) receptionToken = token;
      if (role === ClinicRole.DENTIST) dentistToken = token;
      if (role === ClinicRole.ASSISTANT) assistantToken = token;
    }
    // Recepción acotada a la sede Oeste (DX-089).
    const email = 'recepcion-oeste@avisos-a.test';
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await new PasswordService().hash(SEEDED_PASSWORD),
        fullName: 'Recepción Oeste',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: clinicA.tenantId,
        userId: user.id,
        role: ClinicRole.RECEPTION,
      },
    });
    await api(clinicA, 'put', `/staff/${user.id}/locations`)
      .send({ locationIds: [oeste] })
      .expect(200);
    receptionOesteToken = await loginAs(app, clinicA.host, email);

    tramo1 = (await debtor('Tramouno', 'AV-1', 10, principal)).id;
    tramo2 = (await debtor('Tramodos', 'AV-2', 35, principal)).id;
    tramo3 = (await debtor('Tramotres', 'AV-3', 65, oeste)).id;
    joven = (await debtor('Joven', 'AV-4', 3, principal)).id;
    promesa = (await debtor('Promesa', 'AV-5', 35, principal)).id;
    await raw.paymentPromise.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId: promesa,
        locationId: principal,
        amount: 50,
        currency: 'USD',
        dueDate: new Date(`${addCivilDays(today(), 5)}T00:00:00.000Z`),
        createdById: clinicA.adminUserId,
      },
    });
    baja = (await debtor('Baja', 'AV-6', 35, principal)).id;
    await raw.patient.update({
      where: { id: baja },
      data: { reminderOptOutAt: new Date(), reminderOptOutSource: 'STAFF' },
    });
    const paid = await debtor('Pagado', 'AV-7', 35, principal);
    pagado = paid.id;
    await raw.payment.create({
      data: {
        tenantId: clinicA.tenantId,
        locationId: principal,
        treatmentPlanId: paid.planId,
        patientId: pagado,
        amount: 120,
        currency: 'USD',
        paidAt: noonDaysAgo(2),
        method: 'CASH',
      },
    });
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('lista a quien toca hoy por tramos (Caracas), la más antigua primero, y cuenta las exclusiones', async () => {
    const res = await api(clinicA, 'get', '/receivables/reminders').expect(200);
    const page = pageOf(res);
    expect(page.asOf).toBe(today());
    expect(page.policy).toEqual({
      days: [7, 30, 60],
      maxNotices: 3,
      minGapDays: 7,
    });
    expect(idsOf(res)).toEqual([tramo3, tramo2, tramo1]);
    expect(page.total).toBe(3);
    expect(page.items.map((i) => i.reminder)).toEqual([
      { stage: 3, stageDays: 60, noticesSent: 0, lastNoticeOn: null },
      { stage: 2, stageDays: 30, noticesSent: 0, lastNoticeOn: null },
      { stage: 1, stageDays: 7, noticesSent: 0, lastNoticeOn: null },
    ]);
    // Fila de la cartera: deuda, sede y el número para wa.me (sin «+»).
    const first = page.items[0];
    expect(first.locationId).toBe(oeste);
    expect(first.currencies).toEqual([
      expect.objectContaining({ currency: 'USD', debt: 120 }),
    ]);
    expect(first.patient.whatsApp).toBe('584125550101');
    // Fuera, sin nombres: compromiso abierto y baja; el joven y el pagado ni
    // cuentan (no tocaba avisarles).
    expect(page.excluded).toEqual({ openPromise: 1, optedOut: 1 });
    for (const id of [joven, promesa, baja, pagado]) {
      expect(idsOf(res)).not.toContain(id);
    }
  });

  it('roles: ADMIN y recepción la ven; odontólogo y asistente, 403 en español', async () => {
    await api(clinicA, 'get', '/receivables/reminders', receptionToken).expect(
      200,
    );
    for (const token of [dentistToken, assistantToken]) {
      const res = await api(
        clinicA,
        'get',
        '/receivables/reminders',
        token,
      ).expect(403);
      expect((res.body as { message: string }).message).toBe(
        'Tu rol no tiene acceso a la cartera: es para administración y recepción.',
      );
      const mark = await api(
        clinicA,
        'post',
        `/patients/${tramo1}/balance-reminders`,
        token,
      )
        .send({})
        .expect(403);
      expect((mark.body as { message: string }).message).toBe(
        'Tu rol no gestiona la cobranza: es para administración y recepción.',
      );
    }
  });

  it('aislamiento: otra clínica no ve ni marca a los deudores de A', async () => {
    const res = await api(clinicB, 'get', '/receivables/reminders').expect(200);
    expect(pageOf(res).items).toEqual([]);
    expect(pageOf(res).excluded).toEqual({ openPromise: 0, optedOut: 0 });
    await api(clinicB, 'post', `/patients/${tramo1}/balance-reminders`)
      .send({})
      .expect(404);
  });

  it('sedes permitidas: la recepción de Oeste solo ve y marca deudas de Oeste', async () => {
    const res = await api(
      clinicA,
      'get',
      '/receivables/reminders',
      receptionOesteToken,
    ).expect(200);
    expect(idsOf(res)).toEqual([tramo3]);
    await api(
      clinicA,
      'get',
      `/receivables/reminders?locationId=${principal}`,
      receptionOesteToken,
    ).expect(403);
    await api(
      clinicA,
      'post',
      `/patients/${tramo1}/balance-reminders`,
      receptionOesteToken,
    )
      .send({})
      .expect(403);
    // Con la sede pedida, la del ADMIN también filtra.
    const principalOnly = await api(
      clinicA,
      'get',
      `/receivables/reminders?locationId=${principal}`,
    ).expect(200);
    expect(idsOf(principalOnly)).toEqual([tramo2, tramo1]);
  });

  it('«Marcar avisado» crea la nota REMINDER_SENT y el paciente no reaparece hoy', async () => {
    const res = await api(
      clinicA,
      'post',
      `/patients/${tramo1}/balance-reminders`,
      receptionToken,
    )
      .send({})
      .expect(201);
    expect(res.body).toMatchObject({
      patientId: tramo1,
      channel: 'WHATSAPP_LINK',
      outcome: 'REMINDER_SENT',
      text: null,
      author: { fullName: 'Miembro RECEPTION' },
    });

    const list = await api(clinicA, 'get', '/receivables/reminders').expect(
      200,
    );
    expect(idsOf(list)).toEqual([tramo3, tramo2]);

    // Otra marca hoy: 409 en español, y no deja otra nota.
    const again = await api(
      clinicA,
      'post',
      `/patients/${tramo1}/balance-reminders`,
    )
      .send({ channel: 'CALL' })
      .expect(409);
    expect((again.body as { message: string }).message).toBe(
      'Ya se marcó como avisado hoy: vuelve a aparecer en «Por avisar hoy» cuando le toque el siguiente aviso.',
    );
    const notes = await raw.collectionNote.findMany({
      where: { patientId: tramo1, outcome: 'REMINDER_SENT' },
    });
    expect(notes).toHaveLength(1);

    // La cartera lo muestra como su última gestión.
    const aging = await api(clinicA, 'get', '/receivables/aging').expect(200);
    const row = (
      aging.body as {
        items: { patient: { id: string }; lastNote: { outcome: string } }[];
      }
    ).items.find((i) => i.patient.id === tramo1);
    expect(row?.lastNote.outcome).toBe('REMINDER_SENT');

    // Auditado como gestión de cobranza, sin texto ni importes.
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: 'COLLECTION_NOTE',
        patientId: tramo1,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({ reason: 'BALANCE_REMINDER' });
    expect(JSON.stringify(events[0].metadata)).not.toMatch(/120/);
  });

  it('la nota genérica no admite REMINDER_SENT, y el canal se valida en español', async () => {
    const res = await api(
      clinicA,
      'post',
      `/patients/${tramo2}/collection-notes`,
      receptionToken,
    )
      .send({ channel: 'WHATSAPP_LINK', outcome: 'REMINDER_SENT' })
      .expect(400);
    expect((res.body as { message: string }).message).toBe(
      'El aviso de saldo se registra con «Marcar avisado» en «Por avisar hoy».',
    );
    const bad = await api(
      clinicA,
      'post',
      `/patients/${tramo2}/balance-reminders`,
      receptionToken,
    )
      .send({ channel: 'SMS' })
      .expect(400);
    expect(JSON.stringify(bad.body)).toContain(
      'channel debe ser CALL, WHATSAPP_LINK, EMAIL o IN_PERSON.',
    );
    await api(clinicA, 'post', '/patients/no-es-un-uuid/balance-reminders')
      .send({})
      .expect(400);
  });

  it('política: solo ADMIN la cambia (auditada), con topes en español, y la lista la aplica', async () => {
    const denied = await api(
      clinicA,
      'put',
      '/receivables/reminder-policy',
      receptionToken,
    )
      .send({ days: [40], maxNotices: 1, minGapDays: 7 })
      .expect(403);
    expect((denied.body as { message: string }).message).toBe(
      'Solo un administrador puede cambiar la política de avisos de saldo.',
    );

    const invalid = await api(clinicA, 'put', '/receivables/reminder-policy')
      .send({ days: [30, 7], maxNotices: 3, minGapDays: 7 })
      .expect(400);
    expect((invalid.body as { message: string }).message).toBe(
      'Los tramos van de menor a mayor, sin repetir días.',
    );
    const tooMany = await api(clinicA, 'put', '/receivables/reminder-policy')
      .send({ days: [7, 30, 60, 90], maxNotices: 3, minGapDays: 7 })
      .expect(400);
    expect(JSON.stringify(tooMany.body)).toContain(
      'Indica de 1 a 3 tramos de días.',
    );

    const saved = await api(clinicA, 'put', '/receivables/reminder-policy')
      .send({ days: [40], maxNotices: 1, minGapDays: 7 })
      .expect(200);
    expect(saved.body).toEqual({ days: [40], maxNotices: 1, minGapDays: 7 });
    const list = await api(clinicA, 'get', '/receivables/reminders').expect(
      200,
    );
    expect(idsOf(list)).toEqual([tramo3]);
    expect(pageOf(list).items[0].reminder).toMatchObject({
      stage: 1,
      stageDays: 40,
    });

    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: 'CLINIC_SETTINGS',
      },
    });
    const policyEvents = events.filter(
      (e) =>
        (e.metadata as { reason?: string }).reason ===
        'BALANCE_REMINDER_POLICY',
    );
    expect(policyEvents).toHaveLength(1);

    // Otra clínica conserva la suya.
    const other = await api(clinicB, 'get', '/receivables/reminders').expect(
      200,
    );
    expect(pageOf(other).policy.days).toEqual([7, 30, 60]);
  });
});
