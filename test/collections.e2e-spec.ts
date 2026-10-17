import { INestApplication } from '@nestjs/common';
import {
  AppointmentStatus,
  CatalogKind,
  ClinicRole,
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
} from './support/e2e-fixtures';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { COLLECTIONS_REPOSITORY } from '../src/modules/collections/domain/ports/collections-repository.port';
import type { CollectionsRepository } from '../src/modules/collections/domain/ports/collections-repository.port';
import { SettlePaymentPromises } from '../src/modules/collections/application/settle-payment-promises';
import { PrismaService } from '../src/shared/prisma/prisma.service';

// DX-150 · Cobranza: nota → compromiso → abono → CUMPLIDO, permisos por rol,
// aislamiento entre clínicas, la fila de la cartera y el chip «Saldo vencido»
// de la agenda y la ficha (sin N+1). Siembra de fechas pasadas por DIRECT_URL;
// todo lo demás, por la API.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const BOGOTA = 'America/Bogota';
const today = (): string => civilDateIn(new Date(), BOGOTA);
const noonDaysAgo = (n: number): Date =>
  new Date(`${addCivilDays(today(), -n)}T17:00:00.000Z`);

interface Body {
  items: Record<string, unknown>[];
  promises: Record<string, unknown>[];
  notes: { id: string }[];
  balance: Balance;
}

const bodyOf = (res: { body: unknown }): Body => res.body as Body;

interface Balance {
  hasOverdue: boolean;
  overdueDays: number | null;
  amounts?: { currency: string; amount: number }[];
}

describe('Cobranza — notas, compromisos y saldo vencido (e2e, DX-150)', () => {
  let app: INestApplication<App>;
  let clinicA: Clinic;
  let clinicB: Clinic;
  let catalogItemId: string;
  let receptionToken: string;
  let dentistToken: string;
  let assistantToken: string;
  let deudor: string;
  let deudorPlan: string;
  let alDia: string;

  const server = () => app.getHttpServer();
  const api = (
    clinic: Clinic,
    verb: 'get' | 'post',
    path: string,
    token = clinic.adminToken,
  ) =>
    request(server())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);

  async function patient(clinic: Clinic, firstName: string, doc: string) {
    const row = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName,
        lastName: 'Cobranza',
        docNumber: doc,
        phone: '300 555 0101',
        countryCode: 'CO',
      },
      select: { id: true },
    });
    return row.id;
  }

  async function plan(clinic: Clinic, patientId: string, price: number) {
    const row = await raw.treatmentPlan.create({
      data: {
        tenantId: clinic.tenantId,
        patientId,
        currency: 'COP',
        status: TreatmentPlanStatus.ACCEPTED,
        createdAt: noonDaysAgo(40),
        items: {
          create: {
            toothNumber: '11',
            catalogItemId,
            price,
            status: TreatmentPlanItemStatus.ACCEPTED,
          },
        },
      },
      select: { id: true },
    });
    return row.id;
  }

  async function appointmentToday(
    clinic: Clinic,
    patientId: string,
    locationId: string,
    hour: number,
  ) {
    const start = new Date(
      `${today()}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    );
    await raw.appointment.create({
      data: {
        tenantId: clinic.tenantId,
        locationId,
        patientId,
        providerId: clinic.adminUserId,
        start,
        end: new Date(start.getTime() + 30 * 60 * 1000),
        status: AppointmentStatus.SCHEDULED,
      },
    });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinicA = await registerClinic(app, 'cobranza-a');
    clinicB = await registerClinic(app, 'cobranza-b');
    const sedes = await api(clinicA, 'get', '/locations').expect(200);
    const sede = (sedes.body as { id: string }[])[0].id;

    const catalog = await api(clinicA, 'post', '/catalog/items')
      .send({
        code: 'COBRO',
        kind: CatalogKind.PROCEDURE,
        labelEs: 'Corona',
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

    // Deudor: 500.000 COP de un plan aceptado hace 40 días, sin abonos.
    deudor = await patient(clinicA, 'Debe', 'COB-1');
    deudorPlan = await plan(clinicA, deudor, 500_000);
    alDia = await patient(clinicA, 'Aldia', 'COB-2');
    await appointmentToday(clinicA, deudor, sede, 14);
    await appointmentToday(clinicA, alDia, sede, 15);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('nota → compromiso → abono → CUMPLIDO, y la cartera lo muestra', async () => {
    const note = await api(
      clinicA,
      'post',
      `/patients/${deudor}/collection-notes`,
      receptionToken,
    )
      .send({
        channel: 'CALL',
        outcome: 'PROMISED_PAYMENT',
        text: 'Paga el viernes',
      })
      .expect(201);
    expect(note.body).toMatchObject({
      channel: 'CALL',
      outcome: 'PROMISED_PAYMENT',
      text: 'Paga el viernes',
      author: { fullName: 'Miembro RECEPTION' },
    });

    const dueDate = addCivilDays(today(), 7);
    const promise = await api(
      clinicA,
      'post',
      `/patients/${deudor}/payment-promises`,
      receptionToken,
    )
      .send({ amount: 200000, currency: 'COP', dueDate })
      .expect(201);
    expect(promise.body).toMatchObject({
      amount: 200000,
      currency: 'COP',
      dueDate,
      status: 'OPEN',
      covered: 0,
    });
    const promiseId = (promise.body as { id: string }).id;

    // Un segundo compromiso abierto: 409.
    await api(
      clinicA,
      'post',
      `/patients/${deudor}/payment-promises`,
      receptionToken,
    )
      .send({ amount: 1000, currency: 'COP', dueDate })
      .expect(409);

    let aging = await api(
      clinicA,
      'get',
      '/receivables/aging?hasPromise=true',
      receptionToken,
    ).expect(200);
    expect(bodyOf(aging).items).toHaveLength(1);
    expect(bodyOf(aging).items[0]).toMatchObject({
      patient: { id: deudor },
      lastNote: { channel: 'CALL', outcome: 'PROMISED_PAYMENT' },
      promise: { id: promiseId, status: 'OPEN', dueDate },
    });

    // Dos abonos que suman el importe: el segundo cierra el compromiso.
    for (const amount of [120000, 80000]) {
      await api(
        clinicA,
        'post',
        `/treatment-plans/${deudorPlan}/payments`,
        receptionToken,
      )
        .send({
          amount,
          currency: 'COP',
          paidAt: new Date().toISOString(),
          method: 'CASH',
        })
        .expect(201);
    }

    const collections = await api(
      clinicA,
      'get',
      `/patients/${deudor}/collections`,
      receptionToken,
    ).expect(200);
    expect(bodyOf(collections).promises[0]).toMatchObject({
      id: promiseId,
      status: 'KEPT',
      covered: 200000,
    });
    expect(bodyOf(collections).notes).toHaveLength(1);

    aging = await api(
      clinicA,
      'get',
      '/receivables/aging',
      receptionToken,
    ).expect(200);
    expect(
      (
        bodyOf(aging).items as { patient: { id: string }; promise: unknown }[]
      ).find((r) => r.patient.id === deudor),
    ).toMatchObject({ promise: { id: promiseId, status: 'KEPT' } });
    const withPromise = await api(
      clinicA,
      'get',
      '/receivables/aging?hasPromise=true',
      receptionToken,
    ).expect(200);
    expect(bodyOf(withPromise).items).toEqual([]);

    // Auditoría: crear y cerrar, con el usuario que registró el abono; nunca
    // el texto de la nota.
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: clinicA.tenantId,
        resourceType: { in: ['PAYMENT_PROMISE', 'COLLECTION_NOTE'] },
      },
      select: {
        action: true,
        resourceType: true,
        metadata: true,
        actorRole: true,
      },
    });
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'CREATE',
          resourceType: 'COLLECTION_NOTE',
        }),
        expect.objectContaining({
          action: 'CREATE',
          resourceType: 'PAYMENT_PROMISE',
        }),
        expect.objectContaining({
          action: 'UPDATE',
          resourceType: 'PAYMENT_PROMISE',
          actorRole: 'RECEPTION',
          metadata: { reason: 'PROMISE_KEPT' },
        }),
      ]),
    );
    expect(JSON.stringify(events)).not.toContain('Paga el viernes');

    // Revisión (lead): el CSV de la cartera lleva la gestión y el compromiso,
    // nunca el texto de la nota.
    const csv = await api(
      clinicA,
      'get',
      '/receivables/aging.csv',
      clinicA.adminToken,
    ).expect(200);
    const line = csv.text
      .split('\r\n')
      .find((l) => l.includes(`${dueDate}`) && l.includes('Cumplido'));
    expect(line).toMatch(
      new RegExp(
        `,"Llamada · Promete pago",\\d{4}-\\d{2}-\\d{2},"Cumplido",200000\\.00,COP,${dueDate}$`,
      ),
    );
    expect(csv.text).not.toContain('Paga el viernes');
  });

  it('el barrido marca INCUMPLIDO el día siguiente a la fecha y es idempotente', async () => {
    const otro = await patient(clinicA, 'Promete', 'COB-3');
    await plan(clinicA, otro, 100_000);
    // Compromiso vencido ayer (la API no deja fechas pasadas: se siembra).
    const sede = (
      (await api(clinicA, 'get', '/locations').expect(200)).body as {
        id: string;
      }[]
    )[0].id;
    const promise = await raw.paymentPromise.create({
      data: {
        tenantId: clinicA.tenantId,
        patientId: otro,
        locationId: sede,
        amount: 50_000,
        currency: 'COP',
        dueDate: new Date(`${addCivilDays(today(), -1)}T00:00:00.000Z`),
        createdById: clinicA.adminUserId,
      },
    });
    const settle = app.get(SettlePaymentPromises);
    await settle.run();
    await expect(settle.run()).resolves.toEqual({ kept: 0, broken: 0 });
    const row = await raw.paymentPromise.findUniqueOrThrow({
      where: { id: promise.id },
    });
    expect(row.status).toBe('BROKEN');
  });

  it('validación en español: nota de más de 280, canal inválido, fecha pasada', async () => {
    const long = await api(
      clinicA,
      'post',
      `/patients/${deudor}/collection-notes`,
      receptionToken,
    )
      .send({ channel: 'CALL', outcome: 'NO_ANSWER', text: 'x'.repeat(281) })
      .expect(400);
    expect(JSON.stringify(long.body)).toContain(
      'La nota admite hasta 280 caracteres.',
    );
    await api(
      clinicA,
      'post',
      `/patients/${deudor}/collection-notes`,
      receptionToken,
    )
      .send({ channel: 'FAX', outcome: 'NO_ANSWER' })
      .expect(400);
    const past = await api(
      clinicA,
      'post',
      `/patients/${alDia}/payment-promises`,
      receptionToken,
    )
      .send({
        amount: 1000,
        currency: 'COP',
        dueDate: addCivilDays(today(), -1),
      })
      .expect(400);
    expect(JSON.stringify(past.body)).toContain('no puede ser anterior a hoy');
  });

  it('no hay editar ni borrar notas ni compromisos', async () => {
    const list = await api(
      clinicA,
      'get',
      `/patients/${deudor}/collections`,
      receptionToken,
    ).expect(200);
    const noteId = (bodyOf(list).notes as { id: string }[])[0].id;
    for (const verb of ['patch', 'delete'] as const) {
      await request(server())
        [verb](`/api/v1/patients/${deudor}/collection-notes/${noteId}`)
        .set('X-Tenant-Host', clinicA.host)
        .set('Authorization', `Bearer ${clinicA.adminToken}`)
        .expect(404);
    }
  });

  it.each([
    ['DENTIST', () => dentistToken],
    ['ASSISTANT', () => assistantToken],
  ])('%s: 403 en español en las rutas de cobranza', async (_role, token) => {
    const res = await api(
      clinicA,
      'get',
      `/patients/${deudor}/collections`,
      token(),
    ).expect(403);
    expect(JSON.stringify(res.body)).toContain(
      'Tu rol no gestiona la cobranza',
    );
    await api(clinicA, 'post', `/patients/${deudor}/collection-notes`, token())
      .send({ channel: 'CALL', outcome: 'NO_ANSWER' })
      .expect(403);
    await api(clinicA, 'post', `/patients/${deudor}/payment-promises`, token())
      .send({ amount: 1, currency: 'COP', dueDate: today() })
      .expect(403);
  });

  it('otra clínica no ve ni escribe notas ni compromisos del paciente', async () => {
    await api(clinicB, 'get', `/patients/${deudor}/collections`).expect(404);
    await api(clinicB, 'post', `/patients/${deudor}/collection-notes`)
      .send({ channel: 'CALL', outcome: 'NO_ANSWER' })
      .expect(404);
    await api(clinicB, 'post', `/patients/${deudor}/payment-promises`)
      .send({ amount: 1000, currency: 'COP', dueDate: today() })
      .expect(404);
    const aging = await api(clinicB, 'get', '/receivables/aging').expect(200);
    expect(bodyOf(aging).items).toEqual([]);
  });

  describe('chip «Saldo vencido»', () => {
    const range = () =>
      `/appointments?from=${addCivilDays(today(), -1)}T00:00:00.000Z&to=${addCivilDays(today(), 1)}T23:59:59.000Z`;

    function balanceOf(body: unknown, patientId: string): Balance {
      return (body as { patientId: string; balance: Balance }[]).find(
        (a) => a.patientId === patientId,
      )!.balance;
    }

    it('RECEPTION y ADMIN ven días e importe en la agenda; el paciente al día, sin marca', async () => {
      for (const token of [receptionToken, clinicA.adminToken]) {
        const res = await api(clinicA, 'get', range(), token).expect(200);
        expect(balanceOf(res.body, deudor)).toEqual({
          hasOverdue: true,
          overdueDays: 40,
          amounts: [{ currency: 'COP', amount: 300000 }],
        });
        expect(balanceOf(res.body, alDia)).toEqual({
          hasOverdue: false,
          overdueDays: null,
        });
      }
    });

    it('DENTIST y ASSISTANT solo ven la marca y los días', async () => {
      for (const token of [dentistToken, assistantToken]) {
        const res = await api(clinicA, 'get', range(), token).expect(200);
        const balance = balanceOf(res.body, deudor);
        expect(balance).toEqual({ hasOverdue: true, overdueDays: 40 });
        expect(balance).not.toHaveProperty('amounts');
      }
    });

    it('la cabecera de la ficha lleva la misma marca, con importe solo para ADMIN/RECEPTION', async () => {
      const asReception = await api(
        clinicA,
        'get',
        `/patients/${deudor}`,
        receptionToken,
      ).expect(200);
      expect(bodyOf(asReception).balance).toMatchObject({
        hasOverdue: true,
        overdueDays: 40,
        amounts: [{ currency: 'COP', amount: 300000 }],
      });
      const asDentist = await api(
        clinicA,
        'get',
        `/patients/${deudor}`,
        dentistToken,
      ).expect(200);
      expect(bodyOf(asDentist).balance).toEqual({
        hasOverdue: true,
        overdueDays: 40,
      });
    });

    it('sin N+1: una sola lectura de saldos por petición, con 1 o con muchas citas', async () => {
      const sede = (
        (await api(clinicA, 'get', '/locations').expect(200)).body as {
          id: string;
        }[]
      )[0].id;
      // Revisión (lead): no basta con espiar el repositorio; se cuentan las
      // transacciones con el tenant fijado de TODA la petición (la lista de
      // citas + la marca). Con 6 citas más, las mismas.
      const prisma = app.get(PrismaService);
      const transactions = jest.spyOn(prisma, 'runWithTenant');
      const before = (
        (await api(clinicA, 'get', range(), receptionToken).expect(200))
          .body as unknown[]
      ).length;
      const callsBefore = transactions.mock.calls.length;
      transactions.mockClear();
      for (let i = 0; i < 6; i += 1) {
        const p = await patient(clinicA, `Lote${i}`, `COB-L${i}`);
        await plan(clinicA, p, 10_000 + i);
        await appointmentToday(clinicA, p, sede, 16 + i);
      }
      const repo = app.get<CollectionsRepository>(COLLECTIONS_REPOSITORY);
      const ledgers = jest.spyOn(repo, 'ledgersOf');
      const zones = jest.spyOn(repo, 'locationTimeZones');
      const res = await api(clinicA, 'get', range(), receptionToken).expect(
        200,
      );
      expect((res.body as unknown[]).length).toBeGreaterThanOrEqual(8);
      expect((res.body as unknown[]).length).toBe(before + 6);
      expect(ledgers).toHaveBeenCalledTimes(1);
      expect(zones).toHaveBeenCalledTimes(1);
      ledgers.mockRestore();
      zones.mockRestore();
      // Solo las de la petición medida (las altas de arriba también abren
      // transacciones): se mide otra vez con el espía limpio.
      transactions.mockClear();
      await api(clinicA, 'get', range(), receptionToken).expect(200);
      expect(transactions.mock.calls.length).toBe(callsBefore);
      transactions.mockRestore();
    });
  });
});
