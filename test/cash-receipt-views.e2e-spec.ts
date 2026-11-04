import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PasswordService } from '../src/shared/crypto/password.service';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  SEEDED_PASSWORD,
  seedMember,
} from './support/e2e-fixtures';
import {
  addCivilDays,
  civilDateIn,
  zonedStartOfDay,
} from '../src/shared/time/civil-day';
import { locationBody } from './support/location-fixtures';
import { safeTodayZone, sedeTodayFixture } from './support/sede-clock';

// SEC-043-bis · En el detalle de un cierre a ciegas, el ADMIN ve cuántos
// recibos de abonos que cuentan en esa caja (los suyos y los de todo ajuste:
// un tardío, la anulación de un abono de otra caja) abrió o imprimió quien la
// cerró desde la apertura —o la reapertura— hasta ese cierre. El recuento
// coincide con la auditoría contada aparte. Importes en USD.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// DX-449: la API decide «hoy» con su reloj real y la zona de la sede.
const FIXTURE = sedeTodayFixture();
const ZONE = safeTodayZone();
const today = (): string => civilDateIn(new Date(), ZONE);

interface Closing {
  id: string;
  sequence: number;
  blind: boolean;
  closedAt: string;
  closedBy: { id: string };
  receiptViews: { receipts: number; views: number } | null;
}

interface Detail {
  id: string;
  openedAt: string;
  closing: Closing | null;
  closings: Closing[];
  reopenings: { sequence: number; reopenedAt: string }[];
}

const idOf = (res: { body: unknown }): string =>
  (res.body as { id: string }).id;
const detailOf = (res: { body: unknown }): Detail => res.body as Detail;

describe('Recibos consultados antes de cerrar a ciegas (e2e, SEC-043-bis)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let otra: Clinic;
  let recepcion: string;
  let recepcionId: string;
  let recepcionDos: string;
  let sedeNorte: string;
  let planId: string;
  let caja: string;
  let primero: string;
  let segundo: string;
  let tardio: string;
  let deOtraCaja: string;
  let fuera: string;

  const api = (
    verb: 'get' | 'post' | 'put' | 'delete',
    path: string,
    token = clinic.adminToken,
    host = clinic.host,
  ) =>
    request(app.getHttpServer())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);
  const pay = (
    token: string,
    amount: number,
    method = 'CASH',
    paidAt = today(),
  ) =>
    api('post', `/treatment-plans/${planId}/payments`, token)
      .send({ currency: 'USD', paidAt, amount, method })
      .expect(201);
  const viewReceipt = (id: string, token = recepcion) =>
    api('get', `/payments/${id}/receipt`, token).expect(200);
  const printReceipt = (id: string, token = recepcion) =>
    api('post', `/payments/${id}/receipt/print`, token).expect(200);
  const blind = (blindClose: boolean) =>
    api('put', '/cash-sessions/settings')
      .send({ requireOpenSession: false, blindClose })
      .expect(200);
  const detail = async (id: string, token = clinic.adminToken) =>
    detailOf(await api('get', `/cash-sessions/${id}`, token).expect(200));

  /**
   * Oráculo independiente del SQL: los abonos que cuentan en la caja (los
   * suyos y los de sus ajustes) y los eventos de la auditoría filtrados aquí,
   * en JS, por quien cerró, acción y ventana.
   */
  async function oracle(
    sessionId: string,
    actorUserId: string,
    from: Date,
    to: Date,
  ): Promise<{ receipts: number; views: number }> {
    const own = await raw.payment.findMany({
      where: { tenantId: clinic.tenantId, cashSessionId: sessionId },
      select: { id: true },
    });
    const adjusted = await raw.cashSessionAdjustment.findMany({
      where: { tenantId: clinic.tenantId, sessionId },
      select: { paymentId: true },
    });
    const ids = new Set<string>([
      ...own.map((p) => p.id),
      ...adjusted.flatMap((a) => (a.paymentId ? [a.paymentId] : [])),
    ]);
    const events = (
      await raw.auditEvent.findMany({
        where: { tenantId: clinic.tenantId },
        select: {
          actorUserId: true,
          action: true,
          resourceType: true,
          resourceId: true,
          occurredAt: true,
        },
      })
    ).filter(
      (e) =>
        e.actorUserId === actorUserId &&
        e.resourceType === 'PAYMENT_RECEIPT' &&
        (e.action === 'VIEW' || e.action === 'PRINT') &&
        e.resourceId !== null &&
        ids.has(e.resourceId) &&
        e.occurredAt >= from &&
        e.occurredAt < to,
    );
    return {
      receipts: new Set(events.map((e) => e.resourceId)).size,
      views: events.length,
    };
  }

  /** Una segunda recepcionista (seedMember usa un correo por rol). */
  async function secondReception(): Promise<string> {
    const email = `recepcion2@${clinic.subdomain}.test`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await new PasswordService().hash(SEEDED_PASSWORD),
        fullName: 'Recepción Dos',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: {
        tenantId: clinic.tenantId,
        userId: user.id,
        role: ClinicRole.RECEPTION,
      },
    });
    return loginAs(app, clinic.host, email);
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'recibos-ciego', FIXTURE);
    otra = await registerClinic(app, 'recibos-otra', FIXTURE);
    const r = await seedMember(raw, clinic, ClinicRole.RECEPTION);
    recepcionId = r.userId;
    recepcion = await loginAs(app, clinic.host, r.email);
    recepcionDos = await secondReception();
    sedeNorte = idOf(
      await api('post', '/locations')
        .send(locationBody(FIXTURE, { name: 'Sede Norte' }))
        .expect(201),
    );
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'Carmen',
        lastName: 'Recibos',
        docNumber: 'V-20345678',
      },
      select: { id: true },
    });
    planId = (
      await raw.treatmentPlan.create({
        data: {
          tenantId: clinic.tenantId,
          patientId: patient.id,
          currency: 'USD',
          status: 'ACCEPTED',
        },
        select: { id: true },
      })
    ).id;
    const sedePrincipal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinic.tenantId, name: { not: 'Sede Norte' } },
        select: { id: true },
      })
    ).id;

    await blind(true);
    // Un abono fuera de toda caja (ADMIN sin caja): su recibo no cuenta.
    fuera = idOf(await pay(clinic.adminToken, 7, 'CARD'));
    // La caja X de la otra recepcionista: un abono que el ADMIN (sin caja)
    // anula con X ya cerrada. El VOID queda pendiente y entra en la caja.
    const x = idOf(
      await api('post', '/cash-sessions/open', recepcionDos)
        .send({ floats: [] })
        .expect(201),
    );
    deOtraCaja = idOf(await pay(recepcionDos, 40));
    await api('post', `/cash-sessions/${x}/close`, recepcionDos)
      .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 40 }] })
      .expect(201);
    await api('delete', `/payments/${deOtraCaja}`)
      .send({ reason: 'Abono duplicado' })
      .expect(200);
    // Una caja de AYER ya cerrada en la sede: un abono con fecha de ayer
    // entra como LATE_PAYMENT en la caja abierta de quien cobra.
    const yesterday = addCivilDays(today(), -1);
    const start = zonedStartOfDay(yesterday, ZONE).getTime();
    const hour = 60 * 60 * 1000;
    await raw.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `SET LOCAL session_replication_role = replica`,
      );
      await tx.cashSession.create({
        data: {
          tenantId: clinic.tenantId,
          locationId: sedePrincipal,
          openedById: clinic.adminUserId,
          openedAt: new Date(start + 8 * hour),
          status: 'CLOSED',
          closedAt: new Date(start + 18 * hour),
          closedById: clinic.adminUserId,
        },
      });
    });

    caja = idOf(
      await api('post', '/cash-sessions/open', recepcion)
        .send({ floats: [{ currency: 'USD', amount: 100 }] })
        .expect(201),
    );
    primero = idOf(await pay(recepcion, 30));
    segundo = idOf(await pay(recepcion, 20));
    tardio = idOf(await pay(recepcion, 12, 'CASH', yesterday));
    const kinds = await raw.cashSessionAdjustment.findMany({
      where: { sessionId: caja },
      select: { kind: true, paymentId: true },
    });
    expect(kinds).toEqual(
      expect.arrayContaining([
        { kind: 'VOID', paymentId: deOtraCaja },
        { kind: 'LATE_PAYMENT', paymentId: tardio },
      ]),
    );

    // Quien cuenta: primero ×2 + impreso, segundo, el anulado de la otra caja
    // (VOID) y el tardío (LATE_PAYMENT): 4 recibos, 6 consultas. No cuentan el
    // de fuera, el envío por correo (SEND), lo que abre la otra recepcionista
    // ni lo que abre el ADMIN.
    await viewReceipt(primero);
    await viewReceipt(primero);
    await printReceipt(primero);
    await viewReceipt(segundo);
    await viewReceipt(deOtraCaja);
    await viewReceipt(tardio);
    await viewReceipt(fuera);
    await viewReceipt(primero, recepcionDos);
    await viewReceipt(primero, clinic.adminToken);
    await raw.auditEvent.create({
      data: {
        tenantId: clinic.tenantId,
        actorUserId: recepcionId,
        actorRole: ClinicRole.RECEPTION,
        action: 'SEND',
        resourceType: 'PAYMENT_RECEIPT',
        resourceId: primero,
      },
    });
    await api('post', `/cash-sessions/${caja}/close`, recepcion)
      .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 122 }] })
      .expect(201);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  it('ADMIN ve 4 recibos y 6 consultas (también el VOID y el tardío que cuentan en la caja), y coincide con la auditoría', async () => {
    const view = await detail(caja);
    expect(view.closing).toMatchObject({
      blind: true,
      receiptViews: { receipts: 4, views: 6 },
    });
    expect(
      await oracle(
        caja,
        recepcionId,
        new Date(view.openedAt),
        new Date(view.closing!.closedAt),
      ),
    ).toEqual({ receipts: 4, views: 6 });
  });

  it('dos cierres: la vuelta 2 cuenta desde la reapertura; lo consultado con la caja cerrada no cuenta en ninguna', async () => {
    // Con la caja cerrada (entre el cierre 1 y la reapertura): no cuenta.
    await viewReceipt(segundo);
    await api('post', `/cash-sessions/${caja}/reopen`)
      .send({ reason: 'Revisar el cambio con recepción' })
      .expect(201);
    await viewReceipt(primero);
    await api('post', `/cash-sessions/${caja}/close`, recepcion)
      .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 122 }] })
      .expect(201);

    const view = await detail(caja);
    const [second, first] = view.closings;
    expect(first).toMatchObject({
      sequence: 1,
      receiptViews: { receipts: 4, views: 6 },
    });
    expect(second).toMatchObject({
      sequence: 2,
      receiptViews: { receipts: 1, views: 1 },
    });
    const reopenedAt = new Date(view.reopenings[0].reopenedAt);
    expect(
      await oracle(caja, recepcionId, reopenedAt, new Date(second.closedAt)),
    ).toEqual({ receipts: 1, views: 1 });
  });

  it('recepción no lo recibe (null) y otra clínica no ve la caja', async () => {
    const own = await detail(caja, recepcion);
    expect(own.closings.map((c) => c.receiptViews)).toEqual([null, null]);
    await api(
      'get',
      `/cash-sessions/${caja}`,
      otra.adminToken,
      otra.host,
    ).expect(404);
  });

  it('sin consultas, 0 y 0 (la pantalla no dice nada); sin arqueo ciego, no se calcula (null)', async () => {
    const quiet = idOf(
      await api('post', '/cash-sessions/open', recepcionDos)
        .send({ floats: [] })
        .expect(201),
    );
    await api('post', `/cash-sessions/${quiet}/close`, recepcionDos)
      .send({ counts: [] })
      .expect(201);
    expect((await detail(quiet)).closing?.receiptViews).toEqual({
      receipts: 0,
      views: 0,
    });

    await blind(false);
    const plain = idOf(
      await api('post', '/cash-sessions/open', recepcionDos)
        .send({ floats: [] })
        .expect(201),
    );
    const p = idOf(await pay(recepcionDos, 9));
    await viewReceipt(p, recepcionDos);
    await api('post', `/cash-sessions/${plain}/close`, recepcionDos)
      .send({ counts: [{ currency: 'USD', method: 'CASH', counted: 9 }] })
      .expect(201);
    expect((await detail(plain)).closing).toMatchObject({
      blind: false,
      receiptViews: null,
    });
  });

  it('un miembro restringido a otra sede recibe 403 en la caja (también la suya)', async () => {
    await api('put', `/staff/${recepcionId}/locations`)
      .send({ locationIds: [sedeNorte] })
      .expect(200);
    const restricted = await loginAs(
      app,
      clinic.host,
      `${ClinicRole.RECEPTION.toLowerCase()}@${clinic.subdomain}.test`,
    );
    await api('get', `/cash-sessions/${caja}`, restricted).expect(403);
  });
});
