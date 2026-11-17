import { INestApplication } from '@nestjs/common';
import { CatalogKind, ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import {
  SEEDED_PASSWORD,
  type Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';
import { pinCatalogCurrency } from './support/catalog-currency';
import { PasswordService } from '../src/shared/crypto/password.service';
import { COMMISSION_RULE_MESSAGES } from '../src/modules/commissions/domain/commission-rule';
import { CLOSE_BLOCKER_MESSAGES } from '../src/modules/commissions/domain/settlement-period';
import { COMMISSION_WRITE_FORBIDDEN_MESSAGE } from '../src/modules/commissions/presentation/commissions.controller';

// DX-018 en HTTP real: «Dra. X: 35% de lo cobrado» con detalle por abono, %
// por categoría, base «producido», cierre congelado que sube el cierre
// contable (DX-091), abono anulado después → ajuste en la siguiente, y quién
// ve qué (ADMIN todo; un DENTIST solo lo suyo; otra clínica, 404). Fechas en
// el pasado para cualquier reloj de la CI: septiembre de 2026.
const SEPT = { from: '2026-09-01', to: '2026-09-30' };
const OCT = { from: '2026-10-01', to: '2026-10-31' };

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Line {
  id: string | null;
  kind: 'ACCRUAL' | 'ADJUSTMENT';
  adjustsLineId: string | null;
  patient: { id: string; name: string | null };
  treatmentPlanItemId: string;
  catalogCode: string;
  category: string | null;
  payment: { id: string; amount: number; currency: string } | null;
  currency: string;
  base: number;
  percent: number;
  amount: number;
}
interface Total {
  currency: string;
  accrued: number;
  adjustments: number;
  total: number;
  lines: number;
}
interface Preview {
  professional: { userId: string };
  lines: Line[];
  totals: Total[];
  canClose: boolean;
  blocker: string | null;
  lastClosedTo: string | null;
  nextFrom: string | null;
}
interface Settlement {
  id: string;
  professional: { userId: string };
  period: { from: string; to: string };
  lockDateBefore: string | null;
  lockDateAfter: string;
  totals: Total[];
  lines: Line[];
}

const sum = (values: number[]) =>
  Math.round(values.reduce((a, b) => a + b * 100, 0)) / 100;

describe('Honorarios de odontólogos: regla, vista previa y cierre (e2e, DX-018)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let draX: { userId: string; token: string };
  let drY: { userId: string; token: string };
  let receptionA: string;
  let patientA: string;
  let planA: string;
  let endoItem: string;
  let cleanItem: string;
  let payment1: string;
  let payment2: string;
  let septSettlement: Settlement;

  const server = () => app.getHttpServer();
  const as = (clinic: Clinic, token = clinic.adminToken) => ({
    get: (path: string) =>
      request(server())
        .get(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`),
    post: (path: string, body: object = {}) =>
      request(server())
        .post(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    put: (path: string, body: object) =>
      request(server())
        .put(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    patch: (path: string, body: object) =>
      request(server())
        .patch(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
    delete: (path: string, body: object = {}) =>
      request(server())
        .delete(`/api/v1${path}`)
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`)
        .send(body),
  });

  const preview = (
    period: { from: string; to: string },
    userId?: string,
    token?: string,
  ) =>
    as(a, token).get(
      `/commissions/preview?from=${period.from}&to=${period.to}${userId ? `&userId=${userId}` : ''}`,
    );

  /** Un ítem del catálogo, en el plan, realizado por `userId` el día `completedAt`. */
  async function doneItem(
    catalogItemId: string,
    userId: string,
    completedAt: string,
    toothNumber: string,
  ): Promise<string> {
    const planItem = (
      await as(a)
        .post(`/treatment-plans/${planA}/items`, { toothNumber, catalogItemId })
        .expect(201)
    ).body as { id: string };
    await as(a)
      .patch(`/treatment-plans/${planA}/items/${planItem.id}`, {
        status: 'DONE',
        performedById: userId,
      })
      .expect(200);
    await as(a)
      .patch(`/treatment-plans/${planA}/items/${planItem.id}`, { completedAt })
      .expect(200);
    return planItem.id;
  }

  beforeAll(async () => {
    await resetDatabase(raw);
    app = await createE2eApp();
    a = await registerClinic(app, 'dx018-honorarios-a');
    b = await registerClinic(app, 'dx018-honorarios-b');
    const x = await seedMember(raw, a, ClinicRole.DENTIST);
    draX = { userId: x.userId, token: await loginAs(app, a.host, x.email) };
    // Un segundo odontólogo (seedMember usa un email por rol).
    const yEmail = 'dr.y@dx018-honorarios-a.test';
    const y = await raw.user.create({
      data: {
        email: yEmail,
        passwordHash: await new PasswordService().hash(SEEDED_PASSWORD),
        fullName: 'Dr. Yánez',
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId: a.tenantId, userId: y.id, role: ClinicRole.DENTIST },
    });
    drY = { userId: y.id, token: await loginAs(app, a.host, yEmail) };
    receptionA = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );

    patientA = (
      (
        await as(a)
          .post('/patients', {
            firstName: 'Carmen',
            lastName: 'Honorarios',
            docType: 'NATIONAL_ID',
            docNumber: 'DX018-A',
            sex: 'F',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    await pinCatalogCurrency(raw, a.tenantId, 'USD');
    const endo = (
      await as(a)
        .post('/catalog/items', {
          code: 'DX018-ENDO',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Endodoncia unirradicular',
          category: 'Endodoncia',
          color: '#2A2B3C',
          defaultPrice: 200,
        })
        .expect(201)
    ).body as { id: string };
    const clean = (
      await as(a)
        .post('/catalog/items', {
          code: 'DX018-LIMP',
          kind: CatalogKind.PROCEDURE,
          labelEs: 'Limpieza',
          category: 'Higiene',
          color: '#3A2B3C',
          defaultPrice: 50,
        })
        .expect(201)
    ).body as { id: string };
    planA = (
      (
        await as(a)
          .post(`/patients/${patientA}/treatment-plans`, { currency: 'USD' })
          .expect(201)
      ).body as { id: string }
    ).id;
    endoItem = await doneItem(
      endo.id,
      draX.userId,
      '2026-09-10T15:00:00.000Z',
      '11',
    );
    cleanItem = await doneItem(
      clean.id,
      draX.userId,
      '2026-09-11T15:00:00.000Z',
      '21',
    );
    // Del Dr. Y: base «producido».
    await doneItem(endo.id, drY.userId, '2026-09-12T15:00:00.000Z', '36');

    payment1 = (
      (
        await as(a, receptionA)
          .post(`/treatment-plans/${planA}/payments`, {
            amount: 200,
            currency: 'USD',
            paidAt: '2026-09-15',
            method: 'CASH',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
    payment2 = (
      (
        await as(a, receptionA)
          .post(`/treatment-plans/${planA}/payments`, {
            amount: 50,
            currency: 'USD',
            paidAt: '2026-09-20',
            method: 'CASH',
          })
          .expect(201)
      ).body as { id: string }
    ).id;
  });

  afterAll(async () => {
    await app.close();
    await resetDatabase(raw);
    await raw.$disconnect();
  });

  it('solo ADMIN configura reglas (403 en español a DENTIST y RECEPTION)', async () => {
    const body = { basis: 'COLLECTED', releaseMode: 'PER_ITEM', percent: 35 };
    const denied = await as(a, draX.token)
      .put(`/commissions/rules/${draX.userId}`, body)
      .expect(403);
    expect((denied.body as { message: string }).message).toBe(
      COMMISSION_WRITE_FORBIDDEN_MESSAGE,
    );
    await as(a, receptionA)
      .put(`/commissions/rules/${draX.userId}`, body)
      .expect(403);
    await as(a, draX.token).get('/commissions/rules').expect(403);
    await as(a, receptionA)
      .get(`/commissions/preview?from=${SEPT.from}&to=${SEPT.to}`)
      .expect(403);
    await as(a, receptionA).get('/commissions/settlements').expect(403);
  });

  it('valida la regla: %, categorías y descuentos sin datos de origen (400 en español)', async () => {
    const path = `/commissions/rules/${draX.userId}`;
    const bad = await as(a)
      .put(path, { basis: 'COLLECTED', releaseMode: 'PER_ITEM', percent: 120 })
      .expect(400);
    expect((bad.body as { message: string }).message).toBe(
      COMMISSION_RULE_MESSAGES.percent,
    );
    const lab = await as(a)
      .put(path, {
        basis: 'COLLECTED',
        releaseMode: 'PER_ITEM',
        percent: 35,
        deductLabCost: true,
      })
      .expect(400);
    expect((lab.body as { message: string }).message).toBe(
      COMMISSION_RULE_MESSAGES.labCostUnavailable,
    );
    await as(a)
      .put(path, {
        basis: 'COLLECTED',
        releaseMode: 'PER_ITEM',
        percent: 35,
        categories: [
          { category: 'Higiene', percent: 20 },
          { category: 'HIGIENE', percent: 25 },
        ],
      })
      .expect(400);
    await as(a)
      .put('/commissions/rules/not-a-uuid', {
        basis: 'COLLECTED',
        releaseMode: 'PER_ITEM',
        percent: 35,
      })
      .expect(400);
  });

  it('«Dra. X: 35% de lo cobrado» (Higiene al 20%) y «Dr. Y: 30% de lo producido»', async () => {
    const saved = await as(a)
      .put(`/commissions/rules/${draX.userId}`, {
        basis: 'COLLECTED',
        releaseMode: 'PER_ITEM',
        percent: 35,
        categories: [{ category: ' Higiene ', percent: 20 }],
      })
      .expect(200);
    expect(saved.body).toMatchObject({
      professional: { userId: draX.userId, role: 'DENTIST' },
      rule: {
        basis: 'COLLECTED',
        releaseMode: 'PER_ITEM',
        percent: 35,
        categories: [{ category: 'Higiene', percent: 20 }],
        active: true,
        deductLabCost: false,
        deductCardFee: false,
      },
    });
    await as(a)
      .put(`/commissions/rules/${drY.userId}`, {
        basis: 'PRODUCED',
        releaseMode: 'PER_ITEM',
        percent: 30,
      })
      .expect(200);
    const rules = (await as(a).get('/commissions/rules').expect(200)).body as {
      professionals: { professional: { userId: string }; rule: unknown }[];
      categories: string[];
      deductionsAvailable: { labCost: boolean; cardFee: boolean };
    };
    expect(rules.categories).toEqual(
      expect.arrayContaining(['Endodoncia', 'Higiene']),
    );
    expect(rules.deductionsAvailable).toEqual({
      labCost: false,
      cardFee: false,
    });
    const withRule = rules.professionals.filter((p) => p.rule !== null);
    expect(withRule.map((p) => p.professional.userId).sort()).toEqual(
      [draX.userId, drY.userId].sort(),
    );
    // Auditado sin importes.
    const events = await raw.auditEvent.findMany({
      where: { tenantId: a.tenantId, resourceType: 'CLINIC_SETTINGS' },
      select: { metadata: true },
    });
    expect(
      events.filter(
        (e) => (e.metadata as { reason?: string }).reason === 'COMMISSION_RULE',
      ),
    ).toHaveLength(2);
  });

  it('vista previa del mes: detalle por abono con el % de la categoría; cada importe en su moneda', async () => {
    const body = (await preview(SEPT, draX.userId).expect(200)).body as Preview;
    expect(body.lines.length).toBeGreaterThanOrEqual(2);
    for (const line of body.lines) {
      expect(line).toMatchObject({
        kind: 'ACCRUAL',
        id: null,
        currency: 'USD',
      });
      expect([payment1, payment2]).toContain(line.payment?.id);
      expect(line.patient).toEqual({ id: patientA, name: 'Carmen Honorarios' });
      expect(line.percent).toBe(line.category === 'Higiene' ? 20 : 35);
      expect(line.amount).toBe(Math.round(line.base * line.percent) / 100);
      expect([endoItem, cleanItem]).toContain(line.treatmentPlanItemId);
    }
    // Lo cobrado y repartido a sus ítems: 200 (endodoncia) + 50 (limpieza).
    expect(sum(body.lines.map((l) => l.base))).toBe(250);
    expect(body.totals).toEqual([
      {
        currency: 'USD',
        accrued: 80,
        adjustments: 0,
        total: 80,
        lines: body.lines.length,
      },
    ]);
    expect(body).toMatchObject({
      canClose: true,
      blocker: null,
      lastClosedTo: null,
    });

    // Base «producido»: los ítems realizados en el período (sin abonos).
    const y = (await preview(SEPT, drY.userId).expect(200)).body as Preview;
    expect(y.lines.map((l) => [l.base, l.amount, l.payment])).toEqual([
      [200, 60, null],
    ]);

    // Fuera del período, nada.
    expect(
      ((await preview(OCT, draX.userId).expect(200)).body as Preview).lines,
    ).toEqual([]);
  });

  it('un DENTIST ve su vista previa y la de otro es 404 (comprobado en la API)', async () => {
    const own = (await preview(SEPT, undefined, draX.token).expect(200))
      .body as Preview;
    expect(own.professional.userId).toBe(draX.userId);
    await preview(SEPT, drY.userId, draX.token).expect(404);
    await preview(SEPT, draX.userId, drY.token).expect(404);
  });

  it('cerrar: solo ADMIN, congela el detalle y sube el cierre contable hasta el último día', async () => {
    await as(a, draX.token)
      .post('/commissions/settlements', { userId: draX.userId, ...SEPT })
      .expect(403);
    const notEnded = await as(a)
      .post('/commissions/settlements', {
        userId: draX.userId,
        from: '2026-09-01',
        to: '2999-12-31',
      })
      .expect(400);
    expect(notEnded.body).toBeDefined();

    const closed = await as(a)
      .post('/commissions/settlements', { userId: draX.userId, ...SEPT })
      .expect(201);
    septSettlement = closed.body as Settlement;
    expect(septSettlement).toMatchObject({
      professional: { userId: draX.userId },
      period: SEPT,
      lockDateBefore: null,
      lockDateAfter: '2026-09-30',
      totals: [{ currency: 'USD', accrued: 80, adjustments: 0, total: 80 }],
    });
    expect(septSettlement.lines.every((l) => l.id !== null)).toBe(true);
    const lock = (
      await as(a).get('/clinic/settings/financial-lock').expect(200)
    ).body as {
      lockDate: string | null;
    };
    expect(lock.lockDate).toBe('2026-09-30');
    // Lo ya liquidado no vuelve a salir.
    expect(
      ((await preview(SEPT, draX.userId).expect(200)).body as Preview).lines,
    ).toEqual([]);
  });

  it('no se cierra solapado, con hueco ni sin terminar (409 con el porqué)', async () => {
    const again = await as(a)
      .post('/commissions/settlements', { userId: draX.userId, ...SEPT })
      .expect(409);
    expect(again.body).toMatchObject({
      code: 'COMMISSION_CANNOT_CLOSE',
      blocker: 'OVERLAPS_PREVIOUS',
      message: CLOSE_BLOCKER_MESSAGES.OVERLAPS_PREVIOUS,
    });
    const gap = await as(a)
      .post('/commissions/settlements', {
        userId: draX.userId,
        from: '2026-10-05',
        to: '2026-10-31',
      })
      .expect(409);
    expect((gap.body as { blocker: string }).blocker).toBe(
      'GAP_AFTER_PREVIOUS',
    );
    const future = await as(a)
      .post('/commissions/settlements', {
        userId: draX.userId,
        from: '2026-10-01',
        to: '2027-09-30',
      })
      .expect(409);
    expect((future.body as { blocker: string }).blocker).toBe(
      'PERIOD_NOT_ENDED',
    );
    const next = (await preview(OCT, draX.userId).expect(200)).body as Preview;
    expect(next).toMatchObject({
      lastClosedTo: '2026-09-30',
      nextFrom: '2026-10-01',
    });
  });

  it('un abono anulado después del cierre no altera la liquidación: sale como ajuste en la siguiente', async () => {
    await as(a)
      .patch('/clinic/settings/financial-lock', { adminExempt: true })
      .expect(200);
    await as(a)
      .delete(`/payments/${payment2}`, {
        reason: 'Cobro duplicado por error',
        lockOverrideReason: 'Duplicado confirmado con el extracto del banco',
      })
      .expect(200);

    const frozen = (
      await as(a)
        .get(`/commissions/settlements/${septSettlement.id}`)
        .expect(200)
    ).body as Settlement;
    expect(frozen.totals).toEqual(septSettlement.totals);
    expect(frozen.lines).toEqual(septSettlement.lines);

    const october = (await preview(OCT, draX.userId).expect(200))
      .body as Preview;
    const adjustments = october.lines.filter((l) => l.kind === 'ADJUSTMENT');
    expect(adjustments.length).toBeGreaterThan(0);
    for (const adj of adjustments) {
      expect(adj.payment?.id).toBe(payment2);
      expect(adj.amount).toBeLessThan(0);
      expect(septSettlement.lines.map((l) => l.id)).toContain(
        adj.adjustsLineId,
      );
    }
    const paid2 = septSettlement.lines.filter(
      (l) => l.payment?.id === payment2,
    );
    expect(sum(adjustments.map((l) => l.amount))).toBe(
      -sum(paid2.map((l) => l.amount)),
    );
    expect(october.totals[0]).toMatchObject({
      currency: 'USD',
      accrued: 0,
      adjustments: -sum(paid2.map((l) => l.amount)),
    });

    // Cerrar octubre lo deja asentado: noviembre ya no lo repite.
    await as(a)
      .post('/commissions/settlements', { userId: draX.userId, ...OCT })
      .expect(201);
    const november = (
      await preview(
        { from: '2026-11-01', to: '2026-11-02' },
        draX.userId,
      ).expect(200)
    ).body as Preview;
    expect(november.lines).toEqual([]);
  });

  it('el DENTIST lista y abre solo sus liquidaciones; otro, 404', async () => {
    const own = (
      await as(a, draX.token).get('/commissions/settlements').expect(200)
    ).body as Settlement[];
    expect(own.map((s) => s.professional.userId)).toEqual([
      draX.userId,
      draX.userId,
    ]);
    await as(a, draX.token)
      .get(`/commissions/settlements/${septSettlement.id}`)
      .expect(200);
    expect(
      (
        await as(a, drY.token)
          .get(`/commissions/settlements?userId=${draX.userId}`)
          .expect(200)
      ).body,
    ).toEqual([]);
    await as(a, drY.token)
      .get(`/commissions/settlements/${septSettlement.id}`)
      .expect(404);
    const all = (await as(a).get('/commissions/settlements').expect(200))
      .body as Settlement[];
    expect(all).toHaveLength(2);
  });

  it('auditado: cierre (CREATE, sin importes) y el cierre contable que sube', async () => {
    const created = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        resourceType: 'COMMISSION_SETTLEMENT',
        action: 'CREATE',
      },
      select: { resourceId: true, metadata: true },
    });
    expect(created.map((e) => e.resourceId)).toContain(septSettlement.id);
    expect(JSON.stringify(created.map((e) => e.metadata))).not.toMatch(
      /"80"|: ?80[,}]/,
    );
    const views = await raw.auditEvent.count({
      where: {
        tenantId: a.tenantId,
        resourceType: 'COMMISSION_SETTLEMENT',
        action: 'VIEW',
      },
    });
    expect(views).toBeGreaterThan(0);
  });

  // ISOLATION_COVERS: PUT /commissions/rules/:userId
  // ISOLATION_COVERS: GET /commissions/settlements/:id
  // ISOLATION_COVERS: GET /commissions/preview ?userId
  // ISOLATION_COVERS: GET /commissions/settlements ?userId
  // ISOLATION_COVERS: POST /commissions/settlements body.userId
  it('otra clínica: 404 al ver la liquidación y al cambiar la regla de un profesional de A', async () => {
    await as(b)
      .get(`/commissions/settlements/${septSettlement.id}`)
      .expect(404);
    await as(b)
      .put(`/commissions/rules/${draX.userId}`, {
        basis: 'COLLECTED',
        releaseMode: 'PER_ITEM',
        percent: 99,
      })
      .expect(404);
    await as(b)
      .get(
        `/commissions/preview?from=${SEPT.from}&to=${SEPT.to}&userId=${draX.userId}`,
      )
      .expect(404);
    expect(
      (await as(b).get('/commissions/settlements').expect(200)).body,
    ).toEqual([]);
    expect(
      (
        await as(b)
          .get(`/commissions/settlements?userId=${draX.userId}`)
          .expect(200)
      ).body,
    ).toEqual([]);
    await as(b)
      .post('/commissions/settlements', { userId: draX.userId, ...SEPT })
      .expect(404);
    expect(
      await raw.commissionSettlement.count({ where: { tenantId: b.tenantId } }),
    ).toBe(0);
    const rule = await raw.commissionRule.findFirstOrThrow({
      where: { tenantId: a.tenantId, userId: draX.userId },
      select: { percent: true },
    });
    expect(rule.percent.toNumber()).toBe(35);
  });
});
