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
import { ReportSeeder } from './support/reports-fixtures';
import {
  linkTemplates,
  patientLinkSeeding,
  type LinkClinic,
} from './support/patient-links-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import { REPORTS_FORBIDDEN_MESSAGE } from '../src/modules/reports/presentation/locations-comparison.controller';
import {
  PATIENT_LINKS_INVALID_PERIOD_MESSAGE,
  PATIENT_LINKS_PERIOD_TOO_LONG_MESSAGE,
  type PatientLinksReport,
} from '../src/modules/reports/application/use-cases/get-patient-links.use-case';
import type {
  PatientLinkMetrics,
  PatientLinkType,
} from '../src/modules/reports/domain/patient-links';
import {
  generateAnamnesisToken,
  hashAnamnesisToken,
} from '../src/modules/medical-history-submissions/domain/anamnesis-token';

/**
 * DX-424 · «Enlaces del paciente» por HTTP real, sobre la BD. Los enlaces se
 * envían HOY (el período es de ayer a mañana: cubre el día de la sede sea
 * cual sea la hora de la suite): en la sede principal, un consentimiento
 * abierto y firmado y una anamnesis que el paciente abre por la página
 * (POST /public/medical-history/:token/opened); en la Norte, un
 * consentimiento sin abrir. Además el miembro restringido (DX-089), los
 * permisos, la validación, el aislamiento entre clínicas y que no salgan
 * datos de pacientes.
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const { signature, anamnesis } = patientLinkSeeding(raw);

const DAY = 24 * 60 * 60 * 1000;
const civil = (offsetDays: number) =>
  new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);
const PERIOD = { from: civil(-1), to: civil(1) };
const HOUR = 60 * 60 * 1000;

const row = (rows: PatientLinkMetrics[], type: PatientLinkType) => {
  const found = rows.find((r) => r.linkType === type);
  if (!found) throw new Error(`sin fila ${type}`);
  return found;
};

describe('GET /reports/patient-links (DX-424)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let links: LinkClinic;
  const anamnesisToken = generateAnamnesisToken();
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let restrictedAdmin: string;

  const api = () => request(app.getHttpServer());
  const get = (query: object = PERIOD, token = a.adminToken, host = a.host) =>
    api()
      .get('/api/v1/reports/patient-links')
      .query(query)
      .set('X-Tenant-Host', host)
      .set('Authorization', `Bearer ${token}`);
  const report = async (
    query: object = PERIOD,
    token = a.adminToken,
  ): Promise<PatientLinksReport> =>
    (await get(query, token).expect(200)).body as PatientLinksReport;
  const rowsOf = (r: PatientLinksReport, locationId: string) => {
    const found = r.locations.find((l) => l.locationId === locationId);
    if (!found) throw new Error(`sin sede ${locationId}`);
    return found.rows;
  };

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'enlaces-a');
    b = await registerClinic(app, 'enlaces-b');
    tokens.ADMIN = a.adminToken;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.RECEPTION,
      ClinicRole.ASSISTANT,
    ]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
    }
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      })
    ).id;
    const seed = new ReportSeeder(raw, a.tenantId);
    norte = await seed.location('Sede Norte');
    links = {
      tenantId: a.tenantId,
      userId: a.adminUserId,
      seed,
      ...(await linkTemplates(raw, a.tenantId)),
    };
    const sent = new Date(Date.now() - 2 * HOUR);
    await signature(links, {
      locationId: principal,
      createdAt: sent,
      expiresAt: new Date(sent.getTime() + 7 * DAY),
      signedAt: new Date(sent.getTime() + HOUR),
    });
    await signature(links, {
      locationId: norte,
      createdAt: sent,
      expiresAt: new Date(sent.getTime() + 7 * DAY),
    });
    await anamnesis(links, {
      locationId: principal,
      createdAt: sent,
      expiresAt: new Date(sent.getTime() + 7 * DAY),
      tokenHash: hashAnamnesisToken(anamnesisToken),
    });

    // DX-089 no deja restringir a un ADMIN (409), pero el informe respeta el
    // claim `loc` igual: se firma un token de ADMIN con la sede principal.
    restrictedAdmin = (
      await app.get(TokenService).issue({
        sub: a.adminUserId,
        tenantId: a.tenantId,
        role: ClinicRole.ADMIN,
        loc: [principal],
        tv: 0,
      })
    ).accessToken;
  });

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  it('por tipo y sede: el consentimiento firmado cuenta como enviado, abierto y completado en su sede', async () => {
    const r = await report();
    expect(r).toMatchObject({
      from: PERIOD.from,
      to: PERIOD.to,
      locationId: null,
      restrictedToLocations: false,
    });
    expect(typeof r.asOf).toBe('string');
    expect(r.locations.map((l) => l.locationId)).toEqual([principal, norte]);
    expect(rowsOf(r, principal).map((x) => x.linkType)).toEqual([
      'ANAMNESIS',
      'CONSENT_SIGNATURE',
      'BUDGET_SIGNATURE',
      'APPOINTMENT_CONFIRMATION',
      'POST_OP_INSTRUCTIONS',
    ]);
    expect(row(rowsOf(r, principal), 'CONSENT_SIGNATURE')).toMatchObject({
      sent: 1,
      opened: 1,
      completed: 1,
      expiredUnopened: 0,
      openedRate: 100,
      completedRate: 100,
      medianHoursToComplete: 1,
    });
    expect(row(rowsOf(r, norte), 'CONSENT_SIGNATURE')).toMatchObject({
      sent: 1,
      opened: 0,
      completed: 0,
      openedRate: 0,
    });
    expect(row(r.totals, 'CONSENT_SIGNATURE')).toMatchObject({
      sent: 2,
      completed: 1,
      completedRate: 50,
    });
    // Sin envíos: tasas null («—» en la web), no 0.
    expect(row(r.totals, 'BUDGET_SIGNATURE')).toMatchObject({
      sent: 0,
      openedRate: null,
      completedRate: null,
      expiredUnopenedRate: null,
      medianHoursToComplete: null,
    });
    // La confirmación no registra la apertura.
    expect(row(r.totals, 'APPOINTMENT_CONFIRMATION')).toMatchObject({
      tracksOpened: false,
      opened: null,
      expiredUnopened: null,
    });
  });

  it('la anamnesis cuenta como abierta cuando la página avisa, no cuando se lee el enlace', async () => {
    const before = await report();
    expect(row(rowsOf(before, principal), 'ANAMNESIS')).toMatchObject({
      sent: 1,
      opened: 0,
    });
    await api()
      .get(`/api/v1/public/medical-history/${anamnesisToken}`)
      .set('X-Tenant-Host', a.host)
      .expect(200);
    expect(row(rowsOf(await report(), principal), 'ANAMNESIS').opened).toBe(0);
    await api()
      .post(`/api/v1/public/medical-history/${anamnesisToken}/opened`)
      .set('X-Tenant-Host', a.host)
      .expect(204);
    expect(row(rowsOf(await report(), principal), 'ANAMNESIS')).toMatchObject({
      sent: 1,
      opened: 1,
      openedRate: 100,
      completed: 0,
    });
  });

  it('sin datos de pacientes: ni ids, ni nombres, ni emails', async () => {
    const res = await get().expect(200);
    const patients = await raw.patient.findMany({
      where: { tenantId: a.tenantId },
      select: { id: true, firstName: true, lastName: true },
    });
    expect(patients.length).toBeGreaterThan(0);
    for (const p of patients) {
      expect(res.text).not.toContain(p.id);
      expect(res.text).not.toContain(p.lastName);
    }
    expect(res.text).not.toMatch(/paciente@example\.com|pa\*\*\*|Paciente/);
  });

  describe('sedes (DX-089)', () => {
    it('un miembro que solo ve la principal no ve las cifras de la Norte', async () => {
      const r = await report(PERIOD, restrictedAdmin);
      expect(r.restrictedToLocations).toBe(true);
      expect(r.locations.map((l) => l.locationId)).toEqual([principal]);
      expect(row(r.totals, 'CONSENT_SIGNATURE').sent).toBe(1);
      expect(JSON.stringify(r)).not.toContain(norte);
    });

    it('ni pidiéndola: 403 en español', async () => {
      const res = await get(
        { ...PERIOD, locationId: norte },
        restrictedAdmin,
      ).expect(403);
      expect((res.body as { message: string }).message).toBe(
        'No tienes acceso a esta sede.',
      );
    });

    it('ADMIN puede acotar a una sede', async () => {
      const r = await report({ ...PERIOD, locationId: norte });
      expect(r.locationId).toBe(norte);
      expect(r.locations.map((l) => l.locationId)).toEqual([norte]);
      expect(row(r.totals, 'CONSENT_SIGNATURE').sent).toBe(1);
    });

    it('una sede de otra clínica es el mismo 403', async () => {
      await get(
        { ...PERIOD, locationId: principal },
        b.adminToken,
        b.host,
      ).expect(403);
    });
  });

  describe('permisos', () => {
    it.each([ClinicRole.DENTIST, ClinicRole.RECEPTION, ClinicRole.ASSISTANT])(
      '%s recibe 403 en español',
      async (role) => {
        const res = await get(PERIOD, tokens[role]).expect(403);
        expect((res.body as { message: string }).message).toBe(
          REPORTS_FORBIDDEN_MESSAGE,
        );
      },
    );

    it('sin sesión, 401', async () => {
      await api()
        .get('/api/v1/reports/patient-links')
        .query(PERIOD)
        .set('X-Tenant-Host', a.host)
        .expect(401);
    });
  });

  describe('validación (400 en español)', () => {
    it.each([
      [
        { from: '2026-10-31', to: '2026-10-01' },
        PATIENT_LINKS_INVALID_PERIOD_MESSAGE,
      ],
      [
        { from: '2025-01-01', to: '2026-01-02' },
        PATIENT_LINKS_PERIOD_TOO_LONG_MESSAGE,
      ],
    ])('%o', async (query, message) => {
      const res = await get(query).expect(400);
      expect((res.body as { message: string }).message).toBe(message);
    });

    it('fechas e ids mal formados', async () => {
      await get({ from: 'ayer', to: PERIOD.to }).expect(400);
      const res = await get({ ...PERIOD, locationId: 'no-es-un-uuid' }).expect(
        400,
      );
      expect(JSON.stringify(res.body)).toContain(
        'locationId debe ser un UUID.',
      );
    });
  });

  describe('aislamiento entre clínicas', () => {
    it('la clínica B no ve sedes ni enlaces de A', async () => {
      const res = await get(PERIOD, b.adminToken, b.host).expect(200);
      const r = res.body as PatientLinksReport;
      expect(res.text).not.toContain(principal);
      expect(res.text).not.toContain(norte);
      expect(r.totals.every((t) => t.sent === 0)).toBe(true);
    });
  });
});
