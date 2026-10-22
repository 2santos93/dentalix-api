import { INestApplication } from '@nestjs/common';
import { ClinicRole, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  registerClinic,
  resetDatabase,
  seedMember,
  loginAs,
} from './support/e2e-fixtures';
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const DAY = 86400000;
describe('DX-256 visitas y agenda', () => {
  let app: INestApplication<App>,
    a: Clinic,
    b: Clinic,
    patientId: string,
    planId: string,
    itemIds: string[],
    locationId: string,
    otherLocation: string,
    reception: string;
  const call = (
    verb: 'get' | 'post' | 'patch',
    path: string,
    body?: object,
    token?: string,
    clinic?: Clinic,
  ) => {
    const c = clinic ?? a;
    const r = request(app.getHttpServer())
      [verb]('/api/v1' + path)
      .set('X-Tenant-Host', c.host)
      .set('Authorization', 'Bearer ' + (token ?? c.adminToken));
    return body ? r.send(body) : r;
  };
  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'visits-a');
    b = await registerClinic(app, 'visits-b');
    const main = await raw.location.findFirstOrThrow({
      where: { tenantId: a.tenantId },
    });
    locationId = main.id;
    await raw.locationSchedule.updateMany({
      where: { tenantId: a.tenantId },
      data: { deletedAt: new Date() },
    });
    otherLocation = (
      await raw.location.create({
        data: { tenantId: a.tenantId, name: 'Norte' },
      })
    ).id;
    const member = await seedMember(raw, a, ClinicRole.RECEPTION);
    reception = await loginAs(app, a.host, member.email);
    patientId = (
      await raw.patient.create({
        data: {
          tenantId: a.tenantId,
          firstName: 'Ana',
          lastName: 'Visitas',
          phone: '+573001234567',
        },
      })
    ).id;
    const catalog = await raw.dentalCatalogItem.create({
      data: {
        tenantId: a.tenantId,
        code: 'VISIT',
        kind: 'PROCEDURE',
        labelEs: 'Corona',
        color: '#123456',
      },
    });
    planId = (
      await raw.treatmentPlan.create({
        data: { tenantId: a.tenantId, patientId, currency: 'COP' },
      })
    ).id;
    itemIds = [];
    for (let n = 0; n < 3; n++) {
      const i = await raw.treatmentPlanItem.create({
        data: {
          tenantId: a.tenantId,
          planId,
          toothNumber: '46',
          catalogItemId: catalog.id,
          price: 100,
          discount: 10,
        },
      });
      itemIds.push(i.id);
    }
  });
  afterAll(async () => {
    await app?.close();
    await raw.$disconnect();
  });
  it('guarda dos visitas; recepción no organiza y clínica ajena no encuentra el plan', async () => {
    const body = {
      items: itemIds.map((itemId, n) => ({
        itemId,
        visit: n === 0 ? 1 : 2,
        visitLabel: n === 0 ? 'Cirugía' : 'Corona',
      })),
      visitIntervals: { '2': 90 },
    };
    await call(
      'patch',
      `/treatment-plans/${planId}/visits`,
      body,
      reception,
    ).expect(403);
    await call(
      'patch',
      `/treatment-plans/${planId}/visits`,
      body,
      b.adminToken,
      b,
    ).expect(404);
    const r = await call(
      'patch',
      `/treatment-plans/${planId}/visits`,
      body,
    ).expect(200);
    expect(
      (r.body as { items: { visit: number }[] }).items
        .map((i) => i.visit)
        .sort(),
    ).toEqual([1, 2, 2]);
    await call('patch', `/treatment-plans/${planId}`, {
      status: 'ACCEPTED',
    }).expect(200);
  });
  it('lista por sede y moneda, agenda con ítems, evita duplicados y cancelar libera', async () => {
    const page = await call(
      'get',
      `/treatment-plans/unscheduled?locationId=${locationId}`,
      undefined,
      reception,
    ).expect(200);
    expect(
      (
        page.body as {
          items: { planId: string; currency: string; total: number }[];
        }
      ).items,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ planId, currency: 'COP', total: 270 }),
      ]),
    );
    const north = await call(
      'get',
      `/treatment-plans/unscheduled?locationId=${otherLocation}`,
    ).expect(200);
    expect((north.body as { items: unknown[] }).items).toHaveLength(0);
    const create = (offset: number) => ({
      patientId,
      providerId: a.adminUserId,
      start: new Date(Date.now() + offset * DAY).toISOString(),
      end: new Date(Date.now() + offset * DAY + 1800000).toISOString(),
      planItemIds: [itemIds[1], itemIds[2]],
      reason: 'Visita 2',
    });
    const r = await call(
      'post',
      '/appointments',
      create(100),
      reception,
    ).expect(201);
    const id = (r.body as { id: string }).id;
    expect((r.body as { planItemIds: string[] }).planItemIds.sort()).toEqual(
      [itemIds[1], itemIds[2]].sort(),
    );
    const duplicate = await call(
      'post',
      '/appointments',
      create(101),
      reception,
    ).expect(409);
    expect((duplicate.body as { message: string }).message).toContain(
      'otra cita',
    );
    const linkEvents = () =>
      raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          resourceType: 'APPOINTMENT',
          resourceId: id,
          metadata: { path: ['reason'], equals: 'APPOINTMENT_PLAN_ITEMS' },
        },
        select: {
          action: true,
          actorRole: true,
          patientId: true,
          metadata: true,
        },
      });
    // Una cita sin selección no genera motivo de vínculos; un PATCH que
    // pierde contra la reserva anterior tampoco registra un éxito.
    const withoutItems = await call(
      'post',
      '/appointments',
      {
        ...create(101),
        planItemIds: undefined,
      },
      reception,
    ).expect(201);
    const withoutItemsId = (withoutItems.body as { id: string }).id;
    await call(
      'patch',
      `/appointments/${withoutItemsId}`,
      {
        planItemIds: [itemIds[1]],
      },
      reception,
    ).expect(409);
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: a.tenantId,
          resourceId: withoutItemsId,
          metadata: { path: ['reason'], equals: 'APPOINTMENT_PLAN_ITEMS' },
        },
      }),
    ).toBe(0);
    // Ni el POST ni el PATCH rechazados dejan una traza de vínculos exitosa.
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: a.tenantId,
          resourceType: 'APPOINTMENT',
          metadata: { path: ['reason'], equals: 'APPOINTMENT_PLAN_ITEMS' },
        },
      }),
    ).toBe(1);
    for (const planItemIds of [[itemIds[1]], [], [itemIds[1], itemIds[2]]]) {
      await call(
        'patch',
        `/appointments/${id}`,
        { planItemIds },
        reception,
      ).expect(200);
    }
    expect(await linkEvents()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'CREATE',
          actorRole: 'RECEPTION',
          patientId,
          metadata: {
            reason: 'APPOINTMENT_PLAN_ITEMS',
            changedFields: ['planItemIds'],
          },
        }),
        expect.objectContaining({
          action: 'UPDATE',
          actorRole: 'RECEPTION',
          patientId,
          metadata: {
            reason: 'APPOINTMENT_PLAN_ITEMS',
            changedFields: ['planItemIds'],
          },
        }),
      ]),
    );
    expect(await linkEvents()).toHaveLength(4);
    await call(
      'patch',
      `/appointments/${id}`,
      { status: 'CANCELLED' },
      reception,
    ).expect(200);
    expect(await linkEvents()).toHaveLength(4); // Cancelar no solicita editar vínculos.
    await call('post', '/appointments', create(102), reception).expect(201);
  });
  it('reorganiza un plan firmado sin alterar snapshot ni hash de precios', async () => {
    const quote = await call(
      'get',
      `/patients/${patientId}/treatment-plans/${planId}/quote`,
    ).expect(200);
    const signed = await call(
      'post',
      `/patients/${patientId}/treatment-plans/${planId}/acceptance`,
      {
        contentHash: (quote.body as { contentHash: string }).contentHash,
        signerName: 'Ana Visitas',
        signature:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      },
    ).expect(201);
    await call('patch', `/treatment-plans/${planId}/visits`, {
      items: itemIds.map((itemId, n) => ({
        itemId,
        visit: n === 0 ? 1 : 2,
        visitLabel: n === 0 ? 'Cirugía' : 'Corona',
      })),
      visitIntervals: { '2': 90 },
    }).expect(200);
    const after = await call(
      'get',
      `/patients/${patientId}/treatment-plans/${planId}/quote`,
    ).expect(200);
    expect((after.body as { contentHash: string }).contentHash).toBe(
      (signed.body as { contentHash: string }).contentHash,
    );
    expect(
      (after.body as { acceptance: { integrityOk: boolean } }).acceptance
        .integrityOk,
    ).toBe(true);
    expect((after.body as { items: unknown[] }).items).toEqual(
      (signed.body as { items: unknown[] }).items,
    );
  });
  it('calcula fecha civil de la visita anterior e intervalo sin reagrupar los precios', async () => {
    const past = await raw.appointment.create({
      data: {
        tenantId: a.tenantId,
        locationId,
        patientId,
        providerId: a.adminUserId,
        start: new Date('2026-09-30T23:30:00Z'),
        end: new Date('2026-10-01T00:30:00Z'),
        status: 'COMPLETED',
      },
    });
    await raw.appointmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        patientId,
        appointmentId: past.id,
        planItemId: itemIds[0],
      },
    });
    const res = await call('get', `/treatment-plans/${planId}/visits`).expect(
      200,
    );
    expect(
      (
        res.body as { visits: { number: number; minimumDay: string }[] }
      ).visits.find((v) => v.number === 2)?.minimumDay,
    ).toBe('2026-12-29');
  });
  it('respeta sedes restringidas y sella la sede de aceptación del contexto', async () => {
    const dentist = await seedMember(raw, a, ClinicRole.DENTIST);
    const membership = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: a.tenantId, userId: dentist.userId },
    });
    await raw.membershipLocation.create({
      data: {
        tenantId: a.tenantId,
        membershipId: membership.id,
        locationId: otherLocation,
      },
    });
    const token = await loginAs(app, a.host, dentist.email);
    await call(
      'get',
      `/treatment-plans/unscheduled?locationId=${locationId}`,
      undefined,
      token,
    ).expect(403);
    const original = await raw.treatmentPlanItem.findUniqueOrThrow({
      where: { id: itemIds[0] },
    });
    const northPlan = await raw.treatmentPlan.create({
      data: { tenantId: a.tenantId, patientId, currency: 'USD' },
    });
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        planId: northPlan.id,
        catalogItemId: original.catalogItemId,
        toothNumber: '47',
        price: 100,
      },
    });
    const accepted = await call(
      'patch',
      `/treatment-plans/${northPlan.id}`,
      { status: 'ACCEPTED' },
      token,
    ).expect(200);
    expect(
      (accepted.body as { acceptedLocationId: string }).acceptedLocationId,
    ).toBe(otherLocation);
    const scoped = await call(
      'get',
      '/treatment-plans/unscheduled',
      undefined,
      token,
    ).expect(200);
    expect(
      (
        scoped.body as { items: { planId: string; currency: string }[] }
      ).items.map((i) => i.planId),
    ).toEqual([northPlan.id]);
    expect(
      (scoped.body as { items: { currency: string }[] }).items[0].currency,
    ).toBe('USD');
    const foreign = await call(
      'get',
      '/treatment-plans/unscheduled',
      undefined,
      b.adminToken,
      b,
    ).expect(200);
    expect((foreign.body as { items: unknown[] }).items).toHaveLength(0);
    await call('get', '/treatment-plans/unscheduled?limit=51').expect(400);
  });
  it('cierra el plan y rechaza reorganizarlo', async () => {
    await call('patch', `/treatment-plans/${planId}`, {
      status: 'COMPLETED',
    }).expect(200);
    await call('patch', `/treatment-plans/${planId}/visits`, {
      items: itemIds.map((itemId) => ({ itemId, visit: 1 })),
      visitIntervals: {},
    }).expect(409);
  });
});
