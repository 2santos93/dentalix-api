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
} from './support/e2e-fixtures';
import { civilDateIn } from '../src/shared/time/civil-day';
import { safeTodayZone, sedeTodayFixture } from './support/sede-clock';
import {
  ADMIN_HAS_ALL_PERMISSIONS_MESSAGE,
  OWN_PERMISSIONS_MESSAGE,
} from '../src/modules/staff/application/use-cases/staff-permissions.use-cases';

// DX-090: permisos extra por membresía. En una clínica sin recepcionista, el
// ADMIN concede PAYMENT_REGISTER a la asistente: registra abonos y opera su
// caja como recepción, pero NO anula. FINANCIAL_REPORTS_VIEW lee reportes y
// caja, sin escribir. PUT /staff/:userId/permissions: solo ADMIN, nunca los
// propios, aislado por clínica y auditado. Importes en USD (Venezuela).

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const FIXTURE = sedeTodayFixture();
const ZONE = safeTodayZone();
const today = (): string => civilDateIn(new Date(), ZONE);
const idOf = (res: { body: unknown }): string =>
  (res.body as { id: string }).id;

describe('Permisos extra por miembro (DX-090)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let asistente: { userId: string; email: string };
  let dentista: { userId: string; email: string };
  let recepcion: { userId: string; email: string };
  let asistenteToken: string;
  let dentistaToken: string;
  let recepcionToken: string;
  let sede: string;
  let planId: string;

  const server = () => app.getHttpServer();
  function api(
    clinic: Clinic,
    token: string,
    verb: 'get' | 'post' | 'put' | 'delete',
    path: string,
  ) {
    return request(server())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`)
      .set('X-Location-Id', sede);
  }
  const grant = (userId: string, permissions: string[], token = a.adminToken) =>
    api(a, token, 'put', `/staff/${userId}/permissions`).send({ permissions });
  const pay = (token: string, amount = 20) =>
    api(a, token, 'post', `/treatment-plans/${planId}/payments`).send({
      amount,
      currency: 'USD',
      method: 'CASH',
      paidAt: today(),
    });
  const permissionEvents = (userId: string) =>
    raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'STAFF_MEMBER',
        resourceId: userId,
        metadata: { path: ['reason'], equals: 'PERMISSIONS_CHANGED' },
      },
      orderBy: { occurredAt: 'asc' },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx090-permisos-a', FIXTURE);
    b = await registerClinic(app, 'dx090-permisos-b', FIXTURE);
    asistente = await seedMember(raw, a, ClinicRole.ASSISTANT);
    dentista = await seedMember(raw, a, ClinicRole.DENTIST);
    recepcion = await seedMember(raw, a, ClinicRole.RECEPTION);
    asistenteToken = await loginAs(app, a.host, asistente.email);
    dentistaToken = await loginAs(app, a.host, dentista.email);
    recepcionToken = await loginAs(app, a.host, recepcion.email);
    sede = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    const patient = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: 'María',
        lastName: 'Abono',
        docNumber: 'V-20123456',
      },
      select: { id: true },
    });
    planId = (
      await raw.treatmentPlan.create({
        data: {
          tenantId: a.tenantId,
          patientId: patient.id,
          currency: 'USD',
          status: 'ACCEPTED',
        },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  it('ASSISTANT sin permiso → 403 al registrar un abono, y GET /me no lo anuncia', async () => {
    await pay(asistenteToken).expect(403);
    const me = await api(a, asistenteToken, 'get', '/me').expect(200);
    expect(me.body).toMatchObject({ effectivePermissions: [] });
  });

  it('GET /me: ADMIN y RECEPTION traen sus permisos de serie', async () => {
    const admin = await api(a, a.adminToken, 'get', '/me').expect(200);
    expect(admin.body).toMatchObject({
      effectivePermissions: ['PAYMENT_REGISTER', 'FINANCIAL_REPORTS_VIEW'],
    });
    const rec = await api(a, recepcionToken, 'get', '/me').expect(200);
    expect(rec.body).toMatchObject({
      effectivePermissions: ['PAYMENT_REGISTER'],
    });
  });

  it('valida el catálogo: un permiso fuera de él → 400 y no escribe', async () => {
    await grant(asistente.userId, ['PAYMENT_VOID']).expect(400);
    await grant(asistente.userId, ['INVENTORY_MANAGE']).expect(400);
    const row = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: a.tenantId, userId: asistente.userId },
      select: { extraPermissions: true },
    });
    expect(row.extraPermissions).toEqual([]);
  });

  it('el ADMIN concede PAYMENT_REGISTER: 200, queda en la ficha y en la auditoría', async () => {
    const res = await grant(asistente.userId, [
      'PAYMENT_REGISTER',
      'PAYMENT_REGISTER',
    ]).expect(200);
    expect(res.body).toEqual({
      extraPermissions: ['PAYMENT_REGISTER'],
      effectivePermissions: ['PAYMENT_REGISTER'],
    });
    const detail = await api(
      a,
      a.adminToken,
      'get',
      `/staff/${asistente.userId}`,
    ).expect(200);
    expect(detail.body).toMatchObject({
      extraPermissions: ['PAYMENT_REGISTER'],
    });

    const events = await permissionEvents(asistente.userId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'UPDATE',
      actorUserId: a.adminUserId,
      metadata: {
        reason: 'PERMISSIONS_CHANGED',
        staffAccess: {
          before: { extraPermissions: [] },
          after: { extraPermissions: ['PAYMENT_REGISTER'] },
        },
      },
    });
    // Repetir el mismo conjunto no deja otro evento.
    await grant(asistente.userId, ['PAYMENT_REGISTER']).expect(200);
    expect(await permissionEvents(asistente.userId)).toHaveLength(1);
  });

  it('con PAYMENT_REGISTER la asistente registra el abono (201) con el MISMO token: el guard lee la membresía vigente', async () => {
    const res = await pay(asistenteToken, 20).expect(201);
    expect(res.body).toMatchObject({ amount: 20, currency: 'USD' });
    const me = await api(a, asistenteToken, 'get', '/me').expect(200);
    expect(me.body).toMatchObject({
      effectivePermissions: ['PAYMENT_REGISTER'],
    });
    // Lo que necesita el bloque «Abonos» del plan y el recibo.
    await api(
      a,
      asistenteToken,
      'get',
      `/treatment-plans/${planId}/payments`,
    ).expect(200);
    await api(
      a,
      asistenteToken,
      'get',
      `/treatment-plans/${planId}/balance`,
    ).expect(200);
    await api(a, asistenteToken, 'get', '/payment-methods').expect(200);
    await api(
      a,
      asistenteToken,
      'get',
      `/payments/${idOf(res)}/receipt`,
    ).expect(200);
  });

  it('con PAYMENT_REGISTER NO puede anular un abono (403), ni reasignarlo, ni cambiar su factura', async () => {
    const paid = idOf(await pay(a.adminToken, 5).expect(201));
    await api(a, asistenteToken, 'delete', `/payments/${paid}`)
      .send({ reason: 'Cobro duplicado' })
      .expect(403);
    await api(
      a,
      asistenteToken,
      'put',
      `/payments/${paid}/external-invoice-number`,
    )
      .send({ externalInvoiceNumber: 'F-0001' })
      .expect(403);
    await api(a, asistenteToken, 'put', `/payments/${paid}/allocations`)
      .send({ allocations: [] })
      .expect(403);
    // La caja nunca le ofrece «Anular», ni en sus propios abonos de hoy.
    const caja = await api(
      a,
      asistenteToken,
      'get',
      `/payments?from=${today()}&to=${today()}`,
    ).expect(200);
    const items = (caja.body as { items: { canVoid: boolean }[] }).items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => !i.canVoid)).toBe(true);
    const row = await raw.payment.findUniqueOrThrow({
      where: { id: paid },
      select: { voidedAt: true },
    });
    expect(row.voidedAt).toBeNull();
  });

  it('con PAYMENT_REGISTER opera SU caja como recepción: abre, cobra y cierra; no reabre ni toca los ajustes', async () => {
    const caja = idOf(
      await api(a, asistenteToken, 'post', '/cash-sessions/open')
        .send({ floats: [{ currency: 'USD', amount: 10 }] })
        .expect(201),
    );
    await pay(asistenteToken, 15).expect(201);
    const detail = await api(
      a,
      asistenteToken,
      'get',
      `/cash-sessions/${caja}`,
    ).expect(200);
    expect(detail.body).toMatchObject({
      can: { close: true, reopen: false, adjust: false },
    });
    await api(a, asistenteToken, 'post', `/cash-sessions/${caja}/close`)
      .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 25 }] })
      .expect(201);
    await api(a, asistenteToken, 'post', `/cash-sessions/${caja}/reopen`)
      .send({ reason: 'Quiero contar otra vez' })
      .expect(403);
    await api(a, asistenteToken, 'put', '/cash-sessions/settings')
      .send({ requireOpenSession: false, blindClose: false })
      .expect(403);
  });

  it('PAYMENT_REGISTER no abre los reportes financieros', async () => {
    await api(
      a,
      asistenteToken,
      'get',
      `/reports/locations-comparison?from=${today()}&to=${today()}`,
    ).expect(403);
  });

  it('FINANCIAL_REPORTS_VIEW lee reportes y caja (de todos), pero no escribe', async () => {
    // Una caja de recepción, abierta: la de otro usuario.
    const cajaRecepcion = idOf(
      await api(a, recepcionToken, 'post', '/cash-sessions/open')
        .send({ floats: [{ currency: 'USD', amount: 50 }] })
        .expect(201),
    );
    await api(
      a,
      dentistaToken,
      'get',
      `/reports/locations-comparison?from=${today()}&to=${today()}`,
    ).expect(403);

    await grant(dentista.userId, ['FINANCIAL_REPORTS_VIEW']).expect(200);

    const range = `from=${today()}&to=${today()}`;
    await api(
      a,
      dentistaToken,
      'get',
      `/reports/locations-comparison?${range}`,
    ).expect(200);
    await api(
      a,
      dentistaToken,
      'get',
      `/reports/profitability?${range}&basis=CASH`,
    ).expect(200);
    await api(
      a,
      dentistaToken,
      'get',
      `/reports/unallocated-payments?${range}`,
    ).expect(200);
    await api(a, dentistaToken, 'get', `/payments?${range}`).expect(200);
    const list = await api(a, dentistaToken, 'get', '/cash-sessions').expect(
      200,
    );
    expect(
      (list.body as { items: { id: string }[] }).items.map((s) => s.id),
    ).toContain(cajaRecepcion);
    const detail = await api(
      a,
      dentistaToken,
      'get',
      `/cash-sessions/${cajaRecepcion}`,
    ).expect(200);
    expect(detail.body).toMatchObject({
      can: { close: false, reopen: false, adjust: false },
    });

    // Escribir, no.
    await pay(dentistaToken).expect(403);
    await api(a, dentistaToken, 'post', '/cash-sessions/open')
      .send({ floats: [{ currency: 'USD', amount: 10 }] })
      .expect(403);
    await api(a, dentistaToken, 'post', `/cash-sessions/${cajaRecepcion}/close`)
      .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 50 }] })
      .expect(403);
    await api(
      a,
      recepcionToken,
      'post',
      `/cash-sessions/${cajaRecepcion}/close`,
    )
      .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 50 }] })
      .expect(201);
  });

  it('sin autoconcesión: un ADMIN no cambia sus propios permisos (403) y nadie más que un ADMIN los cambia', async () => {
    const own = await grant(a.adminUserId, ['PAYMENT_REGISTER']).expect(403);
    expect((own.body as { message: string }).message).toBe(
      OWN_PERMISSIONS_MESSAGE,
    );
    await grant(
      asistente.userId,
      ['PAYMENT_REGISTER', 'FINANCIAL_REPORTS_VIEW'],
      asistenteToken,
    ).expect(403);
    await grant(dentista.userId, ['PAYMENT_REGISTER'], recepcionToken).expect(
      403,
    );
    const row = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: a.tenantId, userId: asistente.userId },
      select: { extraPermissions: true },
    });
    expect(row.extraPermissions).toEqual(['PAYMENT_REGISTER']);
  });

  it('a un ADMIN no se le conceden permisos extra (409)', async () => {
    const user = await raw.user.create({
      data: {
        email: `admin2@${a.subdomain}.test`,
        passwordHash: 'x',
        fullName: 'Segunda Administradora',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId: a.tenantId, userId: user.id, role: ClinicRole.ADMIN },
    });
    const res = await grant(user.id, ['PAYMENT_REGISTER']).expect(409);
    expect((res.body as { message: string }).message).toBe(
      ADMIN_HAS_ALL_PERMISSIONS_MESSAGE,
    );
  });

  it('un ADMIN de otra clínica no puede tocar al miembro (404) y no cambia nada', async () => {
    const res = await request(server())
      .put(`/api/v1/staff/${asistente.userId}/permissions`)
      .set('X-Tenant-Host', b.host)
      .set('Authorization', `Bearer ${b.adminToken}`)
      .send({ permissions: [] });
    expect(res.status).toBe(404);
    const row = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: a.tenantId, userId: asistente.userId },
      select: { extraPermissions: true },
    });
    expect(row.extraPermissions).toEqual(['PAYMENT_REGISTER']);
    expect(
      await raw.auditEvent.count({
        where: {
          tenantId: b.tenantId,
          resourceId: asistente.userId,
        },
      }),
    ).toBe(0);
  });

  it('retirar el permiso corta el acceso en la siguiente petición, y queda auditado', async () => {
    await grant(asistente.userId, []).expect(200);
    await pay(asistenteToken).expect(403);
    const events = await permissionEvents(asistente.userId);
    expect(events.at(-1)).toMatchObject({
      metadata: {
        staffAccess: {
          before: { extraPermissions: ['PAYMENT_REGISTER'] },
          after: { extraPermissions: [] },
        },
      },
    });
  });
});
