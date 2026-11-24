import { INestApplication } from '@nestjs/common';
import {
  ClinicRole,
  ExtraPermission,
  Prisma,
  PrismaClient,
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
import {
  RETENTION_EXPECTED_SEGMENTS,
  RETENTION_EXPECTED_TOTALS,
  RETENTION_NOW,
  RETENTION_PERIOD,
  seedRetentionClinic,
  type RetentionClinic,
} from './support/retention-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import {
  RETENTION_CLOCK,
  RETENTION_CSV_FORBIDDEN_MESSAGE,
  RETENTION_FORBIDDEN_MESSAGE,
  RETENTION_LOCATION_NOT_FOUND_MESSAGE,
  RETENTION_PERIOD_TOO_LONG_MESSAGE,
  type RetentionPatientsReport,
  type RetentionReport,
} from '../src/modules/reports/application/use-cases/get-retention.use-case';
import {
  RETENTION_SEGMENTS,
  figureOfSegment,
} from '../src/modules/reports/domain/retention';

/**
 * DX-260 · «Retención» por HTTP real: cifras con los datos semilla conocidos
 * (`retention-fixtures.ts`, «ahora» fijo en RETENTION_CLOCK), cada lista con
 * su cifra, roles (ADMIN; recepción con FINANCIAL_REPORTS_VIEW; clínicos,
 * 403), sedes permitidas (DX-089), 404 de la sede de otra clínica, 400 y
 * auditoría. Las reglas finas y el plan, en los int.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const RETENTION = '/reports/retention';
const PATIENTS = '/reports/retention/patients';

describe('Reportes › Retención (DX-260)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let seeded: RetentionClinic;
  let receptionId: string;
  let onlySur: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};

  function get(path: string, query: object, token: string, clinic = a) {
    return request(app.getHttpServer())
      .get(`/api/v1${path}`)
      .query(query)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  }
  const message = (res: request.Response) =>
    (res.body as { message: unknown }).message;
  const report = async (query: object = {}, token = a.adminToken) =>
    (await get(RETENTION, { ...RETENTION_PERIOD, ...query }, token).expect(200))
      .body as RetentionReport;
  const list = async (query: object, token = a.adminToken) =>
    (
      await get(
        PATIENTS,
        { ...RETENTION_PERIOD, pageSize: 100, ...query },
        token,
      ).expect(200)
    ).body as RetentionPatientsReport;
  const auditEvents = (since: Date) =>
    raw.auditEvent.findMany({
      where: { tenantId: a.tenantId, occurredAt: { gte: since } },
      select: { action: true, resourceType: true, metadata: true },
    });

  beforeAll(async () => {
    app = await createE2eApp((builder) => {
      builder.overrideProvider(RETENTION_CLOCK).useValue(() => RETENTION_NOW);
    });
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx260-a');
    b = await registerClinic(app, 'dx260-b');
    seeded = await seedRetentionClinic(raw, a.tenantId, 'A');
    tokens.ADMIN = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
      if (role === ClinicRole.RECEPTION) receptionId = member.userId;
    }
    onlySur = (
      await app.get(TokenService).issue({
        sub: a.adminUserId,
        tenantId: a.tenantId,
        role: ClinicRole.ADMIN,
        loc: [seeded.sur],
        tv: 0,
      })
    ).accessToken;
  }, 180_000);

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('ADMIN: datos semilla conocidos → 10 activos, 3 nuevos, 2 perdidos, 1 nuevo sin regreso y 80 % (sin auditar: no lleva pacientes)', async () => {
    const since = new Date();
    const r = await report();
    expect(r.totals).toEqual(RETENTION_EXPECTED_TOTALS);
    expect(r.hasData).toBe(true);
    expect(r.filters).toMatchObject({ activeMonths: 18, locationId: null });
    expect(r.rows.map((row) => [row.locationId, row.providerId])).toEqual([
      [seeded.norte, seeded.drNorte],
      [seeded.sur, seeded.drSur],
    ]);
    expect(r.definitions).toHaveLength(7);
    expect(
      r.definitions.find((d) => d.key === 'lost')!.howItIsCalculated,
    ).toContain('18 meses');
    expect(await auditEvents(since)).toEqual([]);
  });

  it.each(RETENTION_SEGMENTS)(
    'cada cifra abre su lista: «%s» tiene tantas filas como la cifra (auditado VIEW)',
    async (segment) => {
      const since = new Date();
      const [r, l] = [await report(), await list({ segment })];
      expect(l.total).toBe(r.totals[figureOfSegment(segment)]);
      expect(l.items).toHaveLength(l.total);
      const byId = new Map(
        Object.entries(seeded.patients).map(([k, id]) => [id, k]),
      );
      expect(l.items.map((i) => byId.get(i.patientId)).sort()).toEqual(
        [...RETENTION_EXPECTED_SEGMENTS[segment]].sort(),
      );
      const events = await auditEvents(since);
      expect(
        events.map((e) => [
          e.action,
          e.resourceType,
          (e.metadata as { reason?: string } | null)?.reason,
        ]),
      ).toEqual([['VIEW', 'PATIENT', 'RETENTION_REPORT']]);
    },
  );

  it('con baja de avisos cuenta en la cifra, pero sin wa.me; la cita futura se marca', async () => {
    const news = await list({ segment: 'new' });
    const n3 = news.items.find((i) => i.patientId === seeded.patients.N3)!;
    expect(n3).toMatchObject({ reminderOptedOut: true, whatsApp: null });
    const n2 = news.items.find((i) => i.patientId === seeded.patients.N2)!;
    expect(n2).toMatchObject({
      reminderOptedOut: false,
      whatsApp: '584125550101',
      hasUpcomingAppointment: true,
    });
  });

  it('clínicos y recepción → 403; recepción con FINANCIAL_REPORTS_VIEW ve el informe y las listas, no el CSV de una lista', async () => {
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ]) {
      const r = await get(RETENTION, RETENTION_PERIOD, tokens[role]!).expect(
        403,
      );
      expect(message(r)).toBe(RETENTION_FORBIDDEN_MESSAGE);
      await get(
        PATIENTS,
        { ...RETENTION_PERIOD, segment: 'lost' },
        tokens[role]!,
      ).expect(403);
      await get(`${RETENTION}.csv`, RETENTION_PERIOD, tokens[role]!).expect(
        403,
      );
    }
    await raw.clinicMembership.updateMany({
      where: { tenantId: a.tenantId, userId: receptionId },
      data: { extraPermissions: [ExtraPermission.FINANCIAL_REPORTS_VIEW] },
    });
    try {
      expect((await report({}, tokens.RECEPTION)).totals).toEqual(
        RETENTION_EXPECTED_TOTALS,
      );
      expect((await list({ segment: 'lost' }, tokens.RECEPTION)).total).toBe(2);
      const csv = await get(
        `${PATIENTS}.csv`,
        { ...RETENTION_PERIOD, segment: 'lost' },
        tokens.RECEPTION!,
      ).expect(403);
      expect(message(csv)).toBe(RETENTION_CSV_FORBIDDEN_MESSAGE);
    } finally {
      await raw.clinicMembership.updateMany({
        where: { tenantId: a.tenantId, userId: receptionId },
        data: { extraPermissions: [] },
      });
    }
  });

  it('restringido a una sede (DX-089): solo lo atribuido allí; otra sede de la clínica, 403; una de otra clínica, 404', async () => {
    const r = await report({}, onlySur);
    expect(r.options.locations.map((l) => l.id)).toEqual([seeded.sur]);
    expect(r.totals).toMatchObject({ activeAtStart: 1, activeAtEnd: 1 });
    const denied = await get(
      RETENTION,
      { ...RETENTION_PERIOD, locationId: seeded.norte },
      onlySur,
    ).expect(403);
    expect(message(denied)).toBe('No tienes acceso a esta sede.');
    const foreign = (
      await raw.location.findFirstOrThrow({ where: { tenantId: b.tenantId } })
    ).id;
    for (const path of [RETENTION, PATIENTS]) {
      const res = await get(
        path,
        { ...RETENTION_PERIOD, segment: 'lost', locationId: foreign },
        a.adminToken,
      ).expect(404);
      expect(message(res)).toBe(RETENTION_LOCATION_NOT_FOUND_MESSAGE);
    }
  });

  it('aislamiento: la clínica B no ve nada de A (sin datos en el período)', async () => {
    const r = (
      await get(RETENTION, RETENTION_PERIOD, b.adminToken, b).expect(200)
    ).body as RetentionReport;
    expect(r).toMatchObject({ rows: [], locations: [], hasData: false });
    expect(r.totals.activeAtStart).toBe(0);
    const l = (
      await get(
        PATIENTS,
        { ...RETENTION_PERIOD, segment: 'active_start' },
        b.adminToken,
        b,
      ).expect(200)
    ).body as RetentionPatientsReport;
    expect(l).toMatchObject({ items: [], total: 0 });
    expect(JSON.stringify(r)).not.toContain(seeded.norte);
  });

  it('CSV: el informe (ADMIN, auditado EXPORT) y la lista de perdidos con teléfono (auditado EXPORT)', async () => {
    const since = new Date();
    const summary = await get(
      `${RETENTION}.csv`,
      RETENTION_PERIOD,
      a.adminToken,
    ).expect(200);
    expect(summary.headers['content-type']).toContain('text/csv');
    expect(summary.headers['content-disposition']).toContain(
      'retencion-2026-01-01-2026-06-30.csv',
    );
    expect(summary.text).toContain('"Total","",10,3,2,11,0,80,1');
    const lost = await get(
      `${PATIENTS}.csv`,
      { ...RETENTION_PERIOD, segment: 'lost' },
      a.adminToken,
    ).expect(200);
    expect(lost.headers['content-disposition']).toContain(
      'retencion-lost-2026-01-01-2026-06-30.csv',
    );
    expect(lost.text).toContain('"Pacientes",2');
    expect(lost.text).toContain('"Paciente P7 A"');
    expect(lost.text).toContain('"Paciente P9 A"');
    const events = await auditEvents(since);
    expect(events.map((e) => [e.action, e.resourceType])).toEqual([
      ['EXPORT', 'PATIENT'],
      ['EXPORT', 'PATIENT'],
    ]);
  });

  it('400: más de 12 meses, umbral no admitido, lista sin cifra o desconocida, UUID inválido', async () => {
    const long = await get(
      RETENTION,
      { from: '2025-01-01', to: '2026-01-01' },
      a.adminToken,
    ).expect(400);
    expect(message(long)).toBe(RETENTION_PERIOD_TOO_LONG_MESSAGE);
    await get(
      RETENTION,
      { ...RETENTION_PERIOD, activeMonths: 6 },
      a.adminToken,
    ).expect(400);
    await get(PATIENTS, RETENTION_PERIOD, a.adminToken).expect(400);
    await get(
      PATIENTS,
      { ...RETENTION_PERIOD, segment: 'churned' },
      a.adminToken,
    ).expect(400);
    await get(
      RETENTION,
      { ...RETENTION_PERIOD, providerId: 'nope' },
      a.adminToken,
    ).expect(400);
    // 24 meses de umbral sí: cambia los cortes y el texto de las definiciones.
    const r = await report({ activeMonths: 24 });
    expect(r.filters.activeMonths).toBe(24);
    expect(
      r.definitions.find((d) => d.key === 'activeAtStart')!.howItIsCalculated,
    ).toContain('24 meses');
  });
});
