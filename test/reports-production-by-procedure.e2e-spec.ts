import { INestApplication } from '@nestjs/common';
import {
  ClinicRole,
  Prisma,
  PrismaClient,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
} from '@prisma/client';
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
import { ReportSeeder } from './support/reports-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import { PRODUCTION_REPORT_FORBIDDEN_MESSAGE } from '../src/modules/reports/presentation/production-by-procedure.controller';
import {
  PRODUCTION_OWN_ONLY_MESSAGE,
  PRODUCTION_PERIOD_TOO_LONG_MESSAGE,
  type ProductionByProcedure,
  type ProductionItems,
} from '../src/modules/reports/application/use-cases/get-production-by-procedure.use-case';
import type { LocationsComparison } from '../src/modules/reports/application/use-cases/get-locations-comparison.use-case';

/**
 * DX-423 · «Producción por procedimiento» por HTTP real. Clínica A (UTC−5)
 * con tres sedes y octubre de 2026:
 *
 *  - Resina (Operatoria) COP en la principal: 100 y 100 de la Dra. Uno y 80
 *    con 20 de descuento del Dr. Dos, catálogo 100 en los tres → 3 · bruto
 *    280 · descuentos 20 · neto 260 · medio 86,67 · catálogo 100 · −13,3 %;
 *  - Resina USD en la Norte: 50 del Dr. Dos, catálogo 60 (dos monedas);
 *  - Profilaxis (Prevención) COP 40 en la Norte, de la Dra. Uno, para un
 *    paciente cuyo plan se presentó en la principal («de» la principal);
 *  - Blanqueamiento (sin categoría) COP 30 en la Sur a las 22:00 del 31/10 en
 *    la zona de la sede (ya 1/11 en UTC): cuenta; otro a las 22:00 del 30/09: no;
 *  - no cuentan: un DONE borrado, uno de un plan borrado, un propuesto, un
 *    aceptado y uno aceptado en un plan cancelado;
 *  - «Sin atribuir»: un DONE sin quién, cuándo ni sede (COP 70) y uno de la
 *    Dra. Uno en la Sur sin fecha (COP 25).
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };
const ROUTE = '/reports/production-by-procedure';

interface Performer {
  userId: string;
  membershipId: string;
}

describe('GET /reports/production-by-procedure (DX-423)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let sur: string;
  let resina: string;
  let profilaxis: string;
  let dentistToken: string;
  let uno: Performer;
  let dos: Performer;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let onlyPrincipal: string;
  let onlyNorte: string;

  function get(path: string, query: object, token: string) {
    return request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .query(query)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${token}`);
  }

  const report = async (
    query: object = {},
    token = a.adminToken,
  ): Promise<ProductionByProcedure> =>
    (await get(ROUTE, { ...OCTOBER, ...query }, token).expect(200))
      .body as ProductionByProcedure;

  async function catalog(
    code: string,
    labelEs: string,
    category: string | null,
  ): Promise<string> {
    const row = await raw.dentalCatalogItem.create({
      data: {
        tenantId: a.tenantId,
        code,
        kind: 'PROCEDURE',
        labelEs,
        category,
        color: '#123456',
      },
      select: { id: true },
    });
    return row.id;
  }

  async function performer(userId: string): Promise<Performer> {
    const m = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: a.tenantId, userId },
      select: { id: true },
    });
    return { userId, membershipId: m.id };
  }

  /** Un plan con UN ítem, sembrado tal cual (las fechas son el pasado). */
  async function item(input: {
    patientId: string;
    catalogItemId: string;
    currency: string;
    price: number;
    discount?: number;
    basePrice?: number;
    status?: TreatmentPlanItemStatus;
    by?: Performer | null;
    locationId?: string | null;
    completedAt?: string | null;
    deleted?: boolean;
    planDeleted?: boolean;
    planStatus?: TreatmentPlanStatus;
    presentedLocationId?: string;
  }): Promise<void> {
    const plan = await raw.treatmentPlan.create({
      data: {
        tenantId: a.tenantId,
        patientId: input.patientId,
        currency: input.currency,
        status: input.planStatus ?? 'ACCEPTED',
        deletedAt: input.planDeleted ? new Date() : null,
        ...(input.presentedLocationId
          ? {
              presentedLocationId: input.presentedLocationId,
              presentedAt: new Date('2026-09-01T15:00:00Z'),
            }
          : {}),
      },
      select: { id: true },
    });
    const status = input.status ?? 'DONE';
    await raw.treatmentPlanItem.create({
      data: {
        tenantId: a.tenantId,
        planId: plan.id,
        toothNumber: '16',
        catalogItemId: input.catalogItemId,
        price: input.price,
        discount: input.discount ?? 0,
        basePrice: input.basePrice ?? null,
        catalogPrice: input.basePrice ?? null,
        status,
        deletedAt: input.deleted ? new Date() : null,
        ...(input.by
          ? {
              performedById: input.by.userId,
              performedByMembershipId: input.by.membershipId,
            }
          : {}),
        performedLocationId: input.locationId ?? null,
        completedAt: input.completedAt ? new Date(input.completedAt) : null,
      },
    });
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'produccion-a');
    b = await registerClinic(app, 'produccion-b');
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    sur = await seed.location('Sede Sur');
    const [p1, p2, p3] = await Promise.all(
      ['Alfa', 'Beta', 'Gama'].map((n) => seed.patient(n)),
    );

    tokens.ADMIN = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
      if (role === ClinicRole.DENTIST) uno = await performer(member.userId);
    }
    dentistToken = tokens.DENTIST!;
    dos = await performer(await seed.provider('Dr. Dos'));

    resina = await catalog('RES-1', 'Resina', 'Operatoria');
    profilaxis = await catalog('PRO-1', 'Profilaxis', 'Prevención');
    const blanqueamiento = await catalog('BLQ-1', 'Blanqueamiento', null);

    const at = (d: string) => `2026-10-${d}T15:00:00Z`;
    // Resina COP en la principal: 100, 100 y 80 con 20 de descuento.
    await item({
      patientId: p1,
      catalogItemId: resina,
      currency: 'COP',
      price: 100,
      basePrice: 100,
      by: uno,
      locationId: principal,
      completedAt: at('05'),
    });
    await item({
      patientId: p2,
      catalogItemId: resina,
      currency: 'COP',
      price: 100,
      basePrice: 100,
      by: uno,
      locationId: principal,
      completedAt: at('06'),
    });
    await item({
      patientId: p3,
      catalogItemId: resina,
      currency: 'COP',
      price: 80,
      discount: 20,
      basePrice: 100,
      by: dos,
      locationId: principal,
      completedAt: at('07'),
    });
    // Resina USD en la Norte.
    await item({
      patientId: p1,
      catalogItemId: resina,
      currency: 'USD',
      price: 50,
      basePrice: 60,
      by: dos,
      locationId: norte,
      completedAt: at('08'),
    });
    // Profilaxis en la Norte de un paciente «de» la principal.
    await item({
      patientId: p2,
      catalogItemId: profilaxis,
      currency: 'COP',
      price: 40,
      basePrice: 40,
      by: uno,
      locationId: norte,
      completedAt: at('09'),
      presentedLocationId: principal,
    });
    // Bordes del período en la zona de la sede.
    await item({
      patientId: p3,
      catalogItemId: blanqueamiento,
      currency: 'COP',
      price: 30,
      by: dos,
      locationId: sur,
      completedAt: '2026-11-01T03:00:00Z',
    });
    await item({
      patientId: p3,
      catalogItemId: blanqueamiento,
      currency: 'COP',
      price: 999,
      by: dos,
      locationId: sur,
      completedAt: '2026-10-01T03:00:00Z',
    });
    // No cuentan.
    await item({
      patientId: p1,
      catalogItemId: resina,
      currency: 'COP',
      price: 1000,
      by: uno,
      locationId: principal,
      completedAt: at('10'),
      deleted: true,
    });
    await item({
      patientId: p1,
      catalogItemId: resina,
      currency: 'COP',
      price: 1000,
      by: uno,
      locationId: principal,
      completedAt: at('10'),
      planDeleted: true,
    });
    await item({
      patientId: p1,
      catalogItemId: resina,
      currency: 'COP',
      price: 1000,
      status: 'PROPOSED',
    });
    await item({
      patientId: p1,
      catalogItemId: resina,
      currency: 'COP',
      price: 1000,
      status: 'ACCEPTED',
    });
    await item({
      patientId: p1,
      catalogItemId: resina,
      currency: 'COP',
      price: 1000,
      status: 'ACCEPTED',
      planStatus: 'CANCELLED',
    });
    // «Sin atribuir» (DX-305).
    await item({
      patientId: p2,
      catalogItemId: profilaxis,
      currency: 'COP',
      price: 70,
    });
    await item({
      patientId: p2,
      catalogItemId: profilaxis,
      currency: 'COP',
      price: 25,
      by: uno,
      locationId: sur,
    });
    // Con fecha y sin sede: «Sin atribuir» de SU período (octubre)…
    await item({
      patientId: p3,
      catalogItemId: profilaxis,
      currency: 'COP',
      price: 15,
      completedAt: at('11'),
    });
    // …y este, de enero de 2020: no sale en octubre.
    await item({
      patientId: p3,
      catalogItemId: profilaxis,
      currency: 'COP',
      price: 90000,
      completedAt: '2020-01-10T15:00:00Z',
    });

    // DX-089: un ADMIN no se restringe (409), pero el reporte respeta `loc`.
    const issue = async (loc: string[]) =>
      (
        await app.get(TokenService).issue({
          sub: a.adminUserId,
          tenantId: a.tenantId,
          role: ClinicRole.ADMIN,
          loc,
          tv: 0,
        })
      ).accessToken;
    onlyPrincipal = await issue([principal]);
    onlyNorte = await issue([norte]);
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('100, 100 y 80 con 20 de descuento: 3 · bruto 280 · descuentos 20 · neto 260 · medio 86,67 · catálogo 100 · −13,3 %', async () => {
    const r = await report();
    expect(
      r.rows.find((x) => x.catalogItemId === resina && x.currency === 'COP'),
    ).toEqual({
      catalogItemId: resina,
      code: 'RES-1',
      label: 'Resina',
      category: 'Operatoria',
      currency: 'COP',
      count: 3,
      gross: 280,
      discounts: 20,
      net: 260,
      averageNet: 86.67,
      catalogAverage: 100,
      catalogCount: 3,
      differencePercent: -13.3,
    });
  });

  it('agrupa por categoría y código; con dos monedas, subtotal y total por moneda, nunca mezclados', async () => {
    const r = await report();
    expect(r.scope).toBe('CLINIC');
    expect(
      r.rows.map((x) => [x.category, x.code, x.currency, x.count, x.net]),
    ).toEqual([
      ['Operatoria', 'RES-1', 'COP', 3, 260],
      ['Operatoria', 'RES-1', 'USD', 1, 50],
      ['Prevención', 'PRO-1', 'COP', 1, 40],
      [null, 'BLQ-1', 'COP', 1, 30],
    ]);
    expect(
      r.categoryTotals.map((c) => [c.category, c.currency, c.net]),
    ).toEqual([
      ['Operatoria', 'COP', 260],
      ['Operatoria', 'USD', 50],
      ['Prevención', 'COP', 40],
      [null, 'COP', 30],
    ]);
    expect(r.totals).toEqual([
      {
        currency: 'COP',
        count: 5,
        gross: 350,
        discounts: 20,
        net: 330,
        averageNet: 66,
      },
      {
        currency: 'USD',
        count: 1,
        gross: 50,
        discounts: 0,
        net: 50,
        averageNet: 50,
      },
    ]);
    // Las del catálogo de la clínica (el registro siembra el suyo).
    expect(r.options.categories).toEqual(
      expect.arrayContaining(['Operatoria', 'Prevención']),
    );
    expect(r.options.locations.map((l) => l.id)).toEqual([
      principal,
      norte,
      sur,
    ]);
  });

  it('borrados, propuestos, aceptados sin hacer y cancelados no cuentan; sin sede (con fecha del período) en «Sin atribuir», sin fecha aparte', async () => {
    const r = await report();
    expect(r.unattributed).toEqual([
      { currency: 'COP', count: 1, gross: 15, discounts: 0, net: 15 },
    ]);
    expect(r.undated).toEqual([
      { currency: 'COP', count: 2, gross: 95, discounts: 0, net: 95 },
    ]);
    expect(r.hasActivity).toBe(true);
  });

  it('un período sin realizados está vacío aunque haya «sin fecha»; el «sin sede» de ese período sí sale', async () => {
    const february = await report({ from: '2020-02-01', to: '2020-02-29' });
    expect(february).toMatchObject({
      rows: [],
      totals: [],
      unattributed: [],
      hasActivity: false,
    });
    expect(february.undated).toEqual([
      { currency: 'COP', count: 2, gross: 95, discounts: 0, net: 95 },
    ]);
    const january = await report({ from: '2020-01-01', to: '2020-01-31' });
    expect(january.unattributed).toEqual([
      { currency: 'COP', count: 1, gross: 90000, discounts: 0, net: 90000 },
    ]);
  });

  it('el total coincide con la producción de «Comparar sedes» del mismo período', async () => {
    const comparison = (
      await get(
        '/reports/locations-comparison',
        { ...OCTOBER, compare: 'none' },
        a.adminToken,
      ).expect(200)
    ).body as LocationsComparison;
    const r = await report();
    expect(
      comparison.total.metrics.production.map((m) => [m.currency, m.value]),
    ).toEqual(r.totals.map((t) => [t.currency, t.net]));
  });

  it('cuenta en la sede donde se realizó: el de la Norte de un paciente «de» la principal no lo ve quien solo ve la principal', async () => {
    const principalOnly = await report({}, onlyPrincipal);
    expect(principalOnly.rows.map((x) => [x.code, x.currency])).toEqual([
      ['RES-1', 'COP'],
    ]);
    expect(principalOnly.options.locations.map((l) => l.id)).toEqual([
      principal,
    ]);
    // Restringido: ni el «Sin atribuir» sin sede ni el de la Sur.
    expect(principalOnly.unattributed).toEqual([]);
    expect(principalOnly.undated).toEqual([]);

    const norteOnly = await report({}, onlyNorte);
    expect(norteOnly.rows.map((x) => [x.code, x.currency])).toEqual([
      ['RES-1', 'USD'],
      ['PRO-1', 'COP'],
    ]);
    // Pedir la principal teniendo solo la Norte: 403.
    await get(ROUTE, { ...OCTOBER, locationId: principal }, onlyNorte).expect(
      403,
    );
  });

  it('filtros de sede, profesional y categoría', async () => {
    const atNorte = await report({ locationId: norte });
    expect(atNorte.rows.map((x) => [x.code, x.currency])).toEqual([
      ['RES-1', 'USD'],
      ['PRO-1', 'COP'],
    ]);
    expect(atNorte.filters.locationName).toBe('Sede Norte');
    expect(atNorte.unattributed).toEqual([]);

    const atSur = await report({ locationId: sur });
    expect(atSur.unattributed).toEqual([]);
    expect(atSur.undated).toEqual([
      { currency: 'COP', count: 1, gross: 25, discounts: 0, net: 25 },
    ]);

    const byDos = await report({ professionalId: dos.userId });
    expect(byDos.rows.map((x) => [x.code, x.currency, x.net])).toEqual([
      ['RES-1', 'COP', 60],
      ['RES-1', 'USD', 50],
      ['BLQ-1', 'COP', 30],
    ]);
    expect(byDos.filters.professionalName).toBe('Dr. Dos');

    const operatoria = await report({ category: 'Operatoria' });
    expect(new Set(operatoria.rows.map((x) => x.category))).toEqual(
      new Set(['Operatoria']),
    );
  });

  it('un DENTIST solo ve su producción, y pedir la de otro es 403; ADMIN ve todo', async () => {
    const own = await report({}, dentistToken);
    expect(own.scope).toBe('OWN');
    expect(own.rows.map((x) => [x.code, x.currency, x.count, x.net])).toEqual([
      ['RES-1', 'COP', 2, 200],
      ['PRO-1', 'COP', 1, 40],
    ]);
    expect(own.unattributed).toEqual([]);
    expect(own.undated).toEqual([
      { currency: 'COP', count: 1, gross: 25, discounts: 0, net: 25 },
    ]);
    expect(own.options.professionals).toEqual([
      { userId: uno.userId, fullName: 'Miembro DENTIST' },
    ]);
    const res = await get(
      ROUTE,
      { ...OCTOBER, professionalId: dos.userId },
      dentistToken,
    ).expect(403);
    expect((res.body as { message: string }).message).toBe(
      PRODUCTION_OWN_ONLY_MESSAGE,
    );
    const admin = await report();
    expect(admin.totals[0].count).toBe(5);
  });

  it('recepción y asistente: 403 en el reporte, el CSV y el detalle', async () => {
    for (const role of [ClinicRole.RECEPTION, ClinicRole.ASSISTANT]) {
      for (const path of [ROUTE, `${ROUTE}.csv`, `${ROUTE}/items`]) {
        const res = await get(
          path,
          { ...OCTOBER, catalogItemId: resina },
          tokens[role]!,
        ).expect(403);
        expect((res.body as { message: string }).message).toBe(
          PRODUCTION_REPORT_FORBIDDEN_MESSAGE,
        );
      }
    }
  });

  it('período de más de 24 meses: 400; 24 meses justos: 200', async () => {
    const res = await get(
      ROUTE,
      { from: '2024-10-01', to: '2026-10-31' },
      a.adminToken,
    ).expect(400);
    expect((res.body as { message: string }).message).toBe(
      PRODUCTION_PERIOD_TOO_LONG_MESSAGE,
    );
    await get(
      ROUTE,
      { from: '2024-11-01', to: '2026-10-31' },
      a.adminToken,
    ).expect(200);
    await get(
      ROUTE,
      { from: '2026-10-31', to: '2026-10-01' },
      a.adminToken,
    ).expect(400);
    // Por calendario: 24 meses y un día (731 días) ya no caben.
    await get(
      ROUTE,
      { from: '2025-01-01', to: '2027-01-01' },
      a.adminToken,
    ).expect(400);
  });

  it('sede de otra clínica: el mismo 403 que una sede no permitida (no dice qué sedes existen)', async () => {
    const foreign = await raw.location.findFirstOrThrow({
      where: { tenantId: b.tenantId },
      select: { id: true },
    });
    const ajena = await get(
      ROUTE,
      { ...OCTOBER, locationId: foreign.id },
      a.adminToken,
    ).expect(403);
    const noPermitida = await get(
      ROUTE,
      { ...OCTOBER, locationId: principal },
      onlyNorte,
    ).expect(403);
    expect(ajena.body).toEqual(noPermitida.body);
  });

  it('el CSV tiene las mismas filas y totales que la pantalla, con período y filtros en la cabecera y sin pacientes', async () => {
    const r = await report({ locationId: norte });
    const res = await get(
      `${ROUTE}.csv`,
      { ...OCTOBER, locationId: norte },
      a.adminToken,
    ).expect(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.headers['content-disposition']).toContain(
      'produccion-por-procedimiento-2026-10-01-2026-10-31.csv',
    );
    const lines = res.text
      .replace(/^\uFEFF/, '')
      .trim()
      .split('\r\n');
    expect(lines.slice(0, 5)).toEqual([
      '"Producción por procedimiento"',
      '"Período","2026-10-01 a 2026-10-31"',
      '"Sede","Sede Norte"',
      '"Profesional","Todo el equipo"',
      '"Categoría","Todas"',
    ]);
    const kind = (l: string) => l.split(',')[0];
    expect(lines.filter((l) => kind(l) === '"Procedimiento"')).toHaveLength(
      r.rows.length,
    );
    expect(lines.filter((l) => kind(l) === '"Subtotal"')).toHaveLength(
      r.categoryTotals.length,
    );
    const totals = lines.filter((l) => kind(l) === '"Total"');
    expect(totals).toEqual(
      r.totals.map(
        (t) =>
          `"Total","","","","${t.currency}",${t.count},${t.gross.toFixed(2)},${t.discounts.toFixed(2)},${t.net.toFixed(2)},${t.averageNet.toFixed(2)},,`,
      ),
    );
    expect(res.text).not.toMatch(/Alfa|Beta|Gama/);
  });

  it('el detalle de una fila: paciente, fecha, profesional y sede; el DENTIST solo los suyos; auditado', async () => {
    const before = new Date();
    const res = await get(
      `${ROUTE}/items`,
      { ...OCTOBER, catalogItemId: resina, currency: 'COP' },
      a.adminToken,
    ).expect(200);
    const detail = res.body as ProductionItems;
    expect(detail.total).toBe(3);
    expect(
      detail.items.map((i) => [i.patientName, i.net, i.locationId]),
    ).toEqual([
      ['Paciente Gama', 60, principal],
      ['Paciente Beta', 100, principal],
      ['Paciente Alfa', 100, principal],
    ]);
    expect(detail.items[0]).toMatchObject({
      professionalName: 'Dr. Dos',
      completedAt: '2026-10-07T15:00:00.000Z',
      timeZone: 'America/Bogota',
    });
    const events = await raw.auditEvent.findMany({
      where: {
        tenantId: a.tenantId,
        actorUserId: a.adminUserId,
        resourceType: 'TREATMENT_PLAN_ITEM',
        occurredAt: { gte: before },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'VIEW' });
    expect(events[0].metadata).toMatchObject({ reason: 'PRODUCTION_REPORT' });

    const own = (
      await get(
        `${ROUTE}/items`,
        { ...OCTOBER, catalogItemId: resina, currency: 'COP' },
        dentistToken,
      ).expect(200)
    ).body as ProductionItems;
    expect(own.total).toBe(2);
    expect(new Set(own.items.map((i) => i.professionalId))).toEqual(
      new Set([uno.userId]),
    );

    const restricted = (
      await get(
        `${ROUTE}/items`,
        { ...OCTOBER, catalogItemId: profilaxis },
        onlyPrincipal,
      ).expect(200)
    ).body as ProductionItems;
    expect(restricted).toMatchObject({ items: [], total: 0 });
  });

  it('otra clínica no ve nada de A', async () => {
    const res = await request(app.getHttpServer())
      .get(`/api/v1${ROUTE}`)
      .query(OCTOBER)
      .set('X-Tenant-Host', b.host)
      .set('Authorization', `Bearer ${b.adminToken}`)
      .expect(200);
    const other = res.body as ProductionByProcedure;
    expect(other).toMatchObject({
      rows: [],
      totals: [],
      unattributed: [],
      hasActivity: false,
    });
    expect(other.options.locations.map((l) => l.id)).not.toContain(principal);
  });
});
