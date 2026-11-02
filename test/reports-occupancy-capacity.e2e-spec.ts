import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  Clinic,
  createE2eApp,
  registerClinic,
  resetDatabase,
} from './support/e2e-fixtures';
import { ReportSeeder } from './support/reports-fixtures';
import { PERIOD_DAY_OUT_OF_RANGE_MESSAGE } from '../src/shared/time/civil-day';
import { UNATTRIBUTED_PREVIOUS_CSV_NOTE } from '../src/modules/reports/application/locations-comparison-csv';
import type {
  ComparisonRow,
  LocationsComparison,
} from '../src/modules/reports/application/use-cases/get-locations-comparison.use-case';

/**
 * DX-305 · «Comparar sedes» con KPIs correctos, por HTTP real y Postgres:
 *
 *  - BE-042: la ocupación divide los minutos atendidos entre la CAPACIDAD de
 *    la sede (Σ horario de cada profesional en ella, menos sus bloqueos y los
 *    cierres), con tope de 100 %. Sedes en la zona de la sede (UTC−5): las 9:00 son las
 *    14:00 UTC.
 *      Sede Tres: tres profesionales con horario los lunes 9–10.
 *      Sede Dos: dos profesionales los martes 9–13 y la sede abierta 9–13
 *        (con la fórmula anterior, dos en paralelo daban 200 %).
 *      Sede Media: una los miércoles 9–17 y otra 9–13 (media jornada).
 *      Sede Sin horario: citas atendidas, ningún profesional con horario.
 *  - BE-044: fechas fuera de 2000-01-01…2100-12-31 → 400 en español en
 *    `/reports/locations-comparison`, `/reports/discounts` y `/payments`.
 *  - BE-045: con un realizado «Sin atribuir» y un período comparado anterior a
 *    DX-050 (la migración de esta base corrió al prepararla, después de 2026),
 *    producción y % de cobro salen sin variación y con la bandera.
 */
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// 2026-10-05 es lunes; 2026-10-06, martes; 2026-10-07, miércoles.
const H = (h: number) => h * 60;

describe('Comparar sedes: capacidad, fechas y producción sin atribuir (DX-305)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let tres: string;
  let dos: string;
  let media: string;
  let sinHorario: string;
  let jueves: string;

  const get = (path: string, query: object) =>
    request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .query(query)
      .set('X-Tenant-Host', a.host)
      .set('Authorization', `Bearer ${a.adminToken}`);

  const report = async (query: object): Promise<LocationsComparison> =>
    (await get('/reports/locations-comparison', query).expect(200))
      .body as LocationsComparison;

  const row = (r: LocationsComparison, id: string): ComparisonRow => {
    const found = r.locations.find((l) => l.locationId === id);
    if (!found) throw new Error(`sin fila para ${id}`);
    return found;
  };

  const day = (d: string) => ({ from: d, to: d, compare: 'none' });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx305-ocupacion');
    const seed = new ReportSeeder(raw, a.tenantId);
    tres = await seed.location('Sede Tres');
    dos = await seed.location('Sede Dos');
    media = await seed.location('Sede Media');
    sinHorario = await seed.location('Sede Sin horario');
    const patients = await Promise.all(
      Array.from({ length: 10 }, (_, i) => seed.patient(`P${i}`)),
    );
    const visit = (
      locationId: string,
      providerId: string,
      patient: number,
      startUtc: string,
      minutes: number,
    ) =>
      seed.completedVisit({
        locationId,
        providerId,
        patientId: patients[patient],
        start: new Date(startUtc),
        minutes,
      });

    // Sede Tres: lunes 9–10, tres profesionales. El 5/10 atiende uno, el
    // 12/10 dos y el 19/10 los tres.
    const [p1, p2, p3] = await Promise.all(
      ['Dra. Uno', 'Dr. Dos', 'Dra. Tres'].map((n) => seed.provider(n)),
    );
    for (const providerId of [p1, p2, p3]) {
      await seed.providerSchedule({
        providerId,
        locationId: tres,
        ranges: [{ weekday: 1, startMinute: H(9), endMinute: H(10) }],
      });
    }
    await visit(tres, p1, 0, '2026-10-05T14:00:00Z', 60);
    await visit(tres, p1, 0, '2026-10-12T14:00:00Z', 60);
    await visit(tres, p2, 1, '2026-10-12T14:00:00Z', 60);
    await visit(tres, p1, 0, '2026-10-19T14:00:00Z', 60);
    await visit(tres, p2, 1, '2026-10-19T14:00:00Z', 60);
    await visit(tres, p3, 2, '2026-10-19T14:00:00Z', 60);

    // Sede Dos: martes 9–13, dos profesionales en paralelo toda la jornada.
    const [p4, p5] = await Promise.all(
      ['Dr. Cuatro', 'Dra. Cinco'].map((n) => seed.provider(n)),
    );
    await seed.locationSchedule(dos, [
      { weekday: 2, startMinute: H(9), endMinute: H(13) },
    ]);
    for (const providerId of [p4, p5]) {
      await seed.providerSchedule({
        providerId,
        locationId: dos,
        ranges: [{ weekday: 2, startMinute: H(9), endMinute: H(13) }],
      });
    }
    await visit(dos, p4, 3, '2026-10-06T14:00:00Z', 240);
    await visit(dos, p5, 4, '2026-10-06T14:00:00Z', 240);

    // Sede Media: miércoles, una 9–17 y otra 9–13; las dos atienden 9–13. El
    // 14/10 la de jornada completa está de vacaciones (bloqueo suyo en todas
    // las sedes).
    const [p6, p7] = await Promise.all(
      ['Dra. Seis', 'Dr. Siete'].map((n) => seed.provider(n)),
    );
    await seed.providerSchedule({
      providerId: p6,
      locationId: media,
      ranges: [{ weekday: 3, startMinute: H(9), endMinute: H(17) }],
    });
    await seed.providerSchedule({
      providerId: p7,
      locationId: media,
      ranges: [{ weekday: 3, startMinute: H(9), endMinute: H(13) }],
    });
    await visit(media, p6, 5, '2026-10-07T14:00:00Z', 240);
    await visit(media, p7, 6, '2026-10-07T14:00:00Z', 240);
    await raw.scheduleBlock.create({
      data: {
        tenantId: a.tenantId,
        providerId: p6,
        start: new Date('2026-10-14T05:00:00Z'),
        end: new Date('2026-10-15T05:00:00Z'),
        kind: 'VACATION',
      },
    });
    await visit(media, p7, 6, '2026-10-14T14:00:00Z', 240);

    // Sede Jueves: jueves 9–13. Atiende toda la jornada la única que sigue
    // en el equipo y puede atender allí; el horario de una desactivada y el de
    // uno acotado (DX-089) a la Sede Tres siguen vivos, pero no son capacidad.
    jueves = await seed.location('Sede Jueves');
    const [p8, p9, p10] = await Promise.all(
      ['Dra. Ocho', 'Dr. Nueve', 'Dra. Diez'].map((n) => seed.provider(n)),
    );
    for (const providerId of [p8, p9, p10]) {
      await seed.providerSchedule({
        providerId,
        locationId: jueves,
        ranges: [{ weekday: 4, startMinute: H(9), endMinute: H(13) }],
      });
    }
    await visit(jueves, p8, 7, '2026-10-08T14:00:00Z', 240);
    await raw.clinicMembership.updateMany({
      where: { tenantId: a.tenantId, userId: p9 },
      data: { deletedAt: new Date('2026-10-20T00:00:00Z') },
    });
    const restricted = await raw.clinicMembership.findFirstOrThrow({
      where: { tenantId: a.tenantId, userId: p10 },
      select: { id: true },
    });
    await raw.membershipLocation.create({
      data: {
        tenantId: a.tenantId,
        membershipId: restricted.id,
        locationId: tres,
      },
    });

    // Sede Sin horario: atendidas, pero nadie tiene horario allí.
    await visit(sinHorario, p1, 7, '2026-10-06T14:00:00Z', 60);

    // BE-045: producción y cobros en la Sede Tres en octubre y septiembre, y
    // un realizado de antes de DX-050 («Sin atribuir»).
    const planOct = await seed.plan({
      patientId: patients[8],
      currency: 'COP',
      price: 120_000,
      done: { locationId: tres, at: new Date('2026-10-05T15:00:00Z') },
    });
    await seed.plan({
      patientId: patients[8],
      currency: 'COP',
      price: 100_000,
      done: { locationId: tres, at: new Date('2026-09-10T15:00:00Z') },
    });
    for (const [amount, paidAt] of [
      [90_000, '2026-10-06T15:00:00Z'],
      [80_000, '2026-09-11T15:00:00Z'],
    ] as const) {
      await seed.payment({
        planId: planOct,
        patientId: patients[8],
        locationId: tres,
        currency: 'COP',
        amount,
        paidAt: new Date(paidAt),
      });
    }
    await seed.unattributedDone({
      patientId: patients[9],
      currency: 'COP',
      price: 500_000,
    });
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  describe('ocupación por capacidad (BE-042)', () => {
    it('1, 2 y 3 profesionales atendiendo de los 3 con horario: 33,33 %, 66,67 % y 100 %', async () => {
      expect(
        row(await report(day('2026-10-05')), tres).metrics.occupancy.value,
      ).toBe(33.33);
      expect(
        row(await report(day('2026-10-12')), tres).metrics.occupancy.value,
      ).toBe(66.67);
      expect(
        row(await report(day('2026-10-19')), tres).metrics.occupancy.value,
      ).toBe(100);
    });

    it('dos profesionales en paralelo toda su jornada: 100 %, no 200 %', async () => {
      const r = await report(day('2026-10-06'));
      expect(row(r, dos).metrics.occupancy.value).toBe(100);
    });

    it('media jornada aporta la mitad de capacidad: 480 ÷ (480 + 240)', async () => {
      const r = await report(day('2026-10-07'));
      expect(row(r, media).metrics.occupancy.value).toBe(66.67);
    });

    it('las vacaciones del profesional quitan su capacidad', async () => {
      // Solo queda la de media jornada (240), que atiende 240.
      const r = await report(day('2026-10-14'));
      expect(row(r, media).metrics.occupancy.value).toBe(100);
    });

    it('el horario de quien ya no está en el equipo o no atiende en la sede (DX-089) no es capacidad', async () => {
      const r = await report(day('2026-10-08'));
      expect(row(r, jueves).metrics.occupancy.value).toBe(100);
    });

    it('una sede sin profesionales con horario sigue con ocupación null y no cuenta en el total', async () => {
      const r = await report(day('2026-10-06'));
      expect(row(r, sinHorario).metrics.occupancy.value).toBeNull();
      expect(row(r, sinHorario).metrics.completedAppointments.value).toBe(1);
      // Total del martes: solo la Sede Dos tiene capacidad ese día (la Tres y
      // la Media trabajan otros días, con 0 de capacidad el martes).
      expect(r.total.metrics.occupancy.value).toBe(100);
    });

    it('nunca pasa del 100 % en ningún día del mes, ni en el total', async () => {
      const r = await report({
        from: '2026-10-01',
        to: '2026-10-31',
        compare: 'none',
      });
      for (const l of [...r.locations, r.total]) {
        const value = l.metrics.occupancy.value;
        if (value !== null) expect(value).toBeLessThanOrEqual(100);
      }
    });

    it('«Cómo se calcula» y el CSV reflejan la capacidad', async () => {
      const r = await report(day('2026-10-06'));
      const def = r.kpis.find((k) => k.key === 'occupancy');
      expect(def?.howItIsCalculated).toContain('horario de cada uno');
      expect(def?.howItIsCalculated).toContain('Nunca pasa del 100 %');
      const csv = await get('/reports/locations-comparison.csv', {
        from: '2026-10-06',
        to: '2026-10-06',
        compare: 'none',
      }).expect(200);
      expect(csv.text).toContain('"Sede Dos","Ocupación %",,100.00,');
    });
  });

  describe('rango de fechas admitido (BE-044)', () => {
    const OUT_OF_RANGE = [
      { from: '9999-12-30', to: '9999-12-31' },
      { from: '2026-10-01', to: '9999-12-31' },
      { from: '1999-12-31', to: '2000-01-01' },
      { from: '2100-12-31', to: '2101-01-01' },
    ];
    const ROUTES = [
      '/reports/locations-comparison',
      '/reports/locations-comparison.csv',
      '/reports/discounts',
      '/payments',
    ];

    it.each(ROUTES)(
      '%s: fuera de 2000-01-01…2100-12-31 → 400 en español, nunca 500',
      async (path) => {
        for (const period of OUT_OF_RANGE) {
          for (const compare of path.startsWith('/reports/locations')
            ? ['none', 'previous', 'previous_year']
            : [undefined]) {
            const res = await get(path, { ...period, compare }).expect(400);
            expect((res.body as { message: string }).message).toBe(
              PERIOD_DAY_OUT_OF_RANGE_MESSAGE,
            );
          }
        }
      },
    );

    it.each(ROUTES)('%s: los bordes del rango sí valen', async (path) => {
      for (const d of ['2000-01-01', '2100-12-31']) {
        for (const compare of path.startsWith('/reports/locations')
          ? ['previous', 'previous_year']
          : [undefined]) {
          await get(path, { from: d, to: d, compare }).expect(200);
        }
      }
    });

    it('/payments: período al revés o de más de 366 días → 400 en español', async () => {
      const reversed = await get('/payments', {
        from: '2026-10-31',
        to: '2026-10-01',
      }).expect(400);
      expect((reversed.body as { message: string }).message).toBe(
        'El período no es válido: usa fechas AAAA-MM-DD con «desde» anterior o igual a «hasta».',
      );
      const long = await get('/payments', {
        from: '2025-01-01',
        to: '2026-01-02',
      }).expect(400);
      expect((long.body as { message: string }).message).toBe(
        'El período admite como mucho 366 días.',
      );
      const shape = await get('/payments', {
        from: '01/10/2026',
        to: '2026-10-31',
      }).expect(400);
      expect(JSON.stringify(shape.body)).toContain(
        'from debe ser una fecha AAAA-MM-DD.',
      );
    });
  });

  describe('producción sin atribuir en el período comparado (BE-045)', () => {
    const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };

    it('producción y % de cobro del anterior salen sin variación, con la bandera', async () => {
      const r = await report({ ...OCTOBER, compare: 'previous' });
      expect(r.previousPeriodUnattributed).toBe(true);
      const sede = row(r, tres);
      expect(sede.previousPeriodUnattributed).toBe(true);
      expect(sede.metrics.production).toEqual([
        {
          currency: 'COP',
          value: 120_000,
          previous: 100_000,
          change: null,
          trend: null,
          previousUnattributed: true,
        },
      ]);
      expect(sede.metrics.collectionRate[0]).toMatchObject({
        value: 75,
        previous: 80,
        change: null,
        trend: null,
        previousUnattributed: true,
      });
      // Lo que no depende de la atribución se sigue comparando.
      expect(sede.metrics.collected[0]).toMatchObject({
        change: 12.5,
        trend: 'BETTER',
      });
      expect(r.total.previousPeriodUnattributed).toBe(true);
      expect(r.total.metrics.production[0].trend).toBeNull();
    });

    it('frente al año anterior (sin producción atribuida) tampoco sale «mejora»', async () => {
      const r = await report({ ...OCTOBER, compare: 'previous_year' });
      expect(row(r, tres).metrics.production[0]).toMatchObject({
        value: 120_000,
        previous: 0,
        trend: null,
        previousUnattributed: true,
      });
    });

    it('sin comparación no hay bandera', async () => {
      const r = await report({ ...OCTOBER, compare: 'none' });
      expect(r.previousPeriodUnattributed).toBe(false);
    });

    it('el CSV lleva el aviso en esas celdas', async () => {
      const res = await get('/reports/locations-comparison.csv', {
        ...OCTOBER,
        compare: 'previous',
      }).expect(200);
      expect(res.text).toContain(
        `"Sede Tres","Producción",COP,120000.00,100000.00,,,,"${UNATTRIBUTED_PREVIOUS_CSV_NOTE}"`,
      );
      expect(res.text).toContain(
        '"Sede Tres","Cobrado",COP,90000.00,80000.00,12.5,%,Mejora,',
      );
    });
  });
});
