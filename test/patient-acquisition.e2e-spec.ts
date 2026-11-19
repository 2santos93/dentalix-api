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
  REGIONAL_CARACAS_FIXTURE,
  locationBody,
} from './support/location-fixtures';
import { TokenService } from '../src/shared/crypto/token.service';
import { ACQUISITION_MESSAGES } from '../src/modules/patients/domain/patient-acquisition';
import { PATIENT_SOURCE_MESSAGES } from '../src/modules/patient-sources/domain/patient-source';
import {
  ACQUISITION_CSV_FORBIDDEN_MESSAGE,
  ACQUISITION_FORBIDDEN_MESSAGE,
} from '../src/modules/reports/presentation/acquisition.controller';
import type { AcquisitionReport } from '../src/modules/reports/application/use-cases/get-acquisition.use-case';
import type { PatientAcquisitionView } from '../src/modules/patient-sources/domain/patient-source-repository.port';

/**
 * DX-172 · «¿Cómo nos conoció?» por HTTP real con Postgres. Clínica A
 * (Caracas) con la sede principal y la Norte; recepción, odontólogo y una
 * recepcionista restringida a Norte. Clínica B para el aislamiento. Las
 * fechas del informe son fijas (octubre de 2026, a mediodía de Caracas): las
 * altas se mueven con el owner, nunca «ahora + N».
 */

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

interface Source {
  id: string;
  name: string;
  kind: string;
  isActive: boolean;
  systemKey: string | null;
}

interface PatientBody {
  id: string;
  sourceId: string | null;
  referredByPatientId: string | null;
  referredByName: string | null;
}

const OCTOBER = { from: '2026-10-01', to: '2026-10-31' };
const IN_OCTOBER = new Date('2026-10-10T16:00:00.000Z');

describe('Origen del paciente y captación (DX-172, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let principal: string;
  let norte: string;
  let bLocation: string;
  const tokens: Partial<Record<ClinicRole, string>> = {};
  let receptionId: string;
  let dentistId: string;
  let receptionOnlyNorte: string;
  let sourcesA: Record<string, Source>;
  let sourcesB: Record<string, Source>;
  let visits = 0;

  const as = (clinic: Clinic, token: string) => {
    const set = (req: request.Test) =>
      req
        .set('X-Tenant-Host', clinic.host)
        .set('Authorization', `Bearer ${token}`);
    const server = () => request(app.getHttpServer());
    return {
      get: (path: string, query: object = {}) =>
        set(server().get(`/api/v1${path}`).query(query)),
      post: (path: string, body: object = {}) =>
        set(server().post(`/api/v1${path}`)).send(body),
      patch: (path: string, body: object = {}) =>
        set(server().patch(`/api/v1${path}`)).send(body),
    };
  };
  const admin = () => as(a, a.adminToken);
  const reception = () => as(a, tokens.RECEPTION!);

  async function sources(clinic: Clinic): Promise<Record<string, Source>> {
    const res = await as(clinic, clinic.adminToken)
      .get('/patient-sources', { includeInactive: true })
      .expect(200);
    return Object.fromEntries(
      (res.body as Source[]).map((s) => [s.systemKey ?? s.name, s]),
    );
  }

  async function createPatient(
    body: object,
    client = reception(),
    status = 201,
  ): Promise<PatientBody & { message?: string }> {
    const res = await client
      .post('/patients', {
        firstName: 'Paciente',
        lastName: 'Prueba',
        docType: 'OTHER',
        sex: 'UNSPECIFIED',
        ...body,
      })
      .expect(status);
    return res.body as PatientBody & { message?: string };
  }

  /** Alta de octubre (fecha fija) y su primera cita en `locationId`. */
  async function octoberPatient(
    lastName: string,
    body: object,
    locationId: string | null,
  ): Promise<string> {
    const p = await createPatient({ lastName, ...body });
    await raw.patient.update({
      where: { id: p.id },
      data: { createdAt: IN_OCTOBER },
    });
    if (locationId) {
      const start = new Date(Date.UTC(2026, 9, 1 + visits++, 16, 0));
      await raw.appointment.create({
        data: {
          tenantId: a.tenantId,
          locationId,
          patientId: p.id,
          providerId: dentistId,
          start,
          end: new Date(start.getTime() + 30 * 60_000),
        },
      });
    }
    return p.id;
  }

  async function pay(
    patientId: string,
    amount: number,
    opts: { currency?: string; locationId?: string; voided?: boolean } = {},
  ): Promise<void> {
    const currency = opts.currency ?? 'VES';
    const plan = await raw.treatmentPlan.create({
      data: { tenantId: a.tenantId, patientId, currency },
      select: { id: true },
    });
    const payment = await raw.payment.create({
      data: {
        tenantId: a.tenantId,
        locationId: opts.locationId ?? principal,
        treatmentPlanId: plan.id,
        patientId,
        amount,
        currency,
        paidAt: new Date('2026-10-20T16:00:00.000Z'),
        method: 'CASH',
      },
      select: { id: true },
    });
    if (opts.voided) {
      await raw.payment.update({
        where: { id: payment.id },
        data: {
          deletedAt: new Date(),
          voidedAt: new Date(),
          voidedById: a.adminUserId,
          voidReason: 'Cobro duplicado',
        },
      });
    }
  }

  const acquisitionOf = async (id: string, client = reception()) =>
    (await client.get(`/patients/${id}/acquisition`).expect(200))
      .body as PatientAcquisitionView;

  const reportOf = async (query: object = {}, client = admin()) =>
    (
      await client
        .get('/reports/acquisition', { ...OCTOBER, ...query })
        .expect(200)
    ).body as AcquisitionReport;

  const rowOf = (r: AcquisitionReport, name: string) =>
    r.rows.find((x) => x.name === name);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx172-a');
    b = await registerClinic(app, 'dx172-b');
    principal = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        select: { id: true },
      })
    ).id;
    bLocation = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: b.tenantId },
        select: { id: true },
      })
    ).id;
    norte = (
      (
        await admin()
          .post(
            '/locations',
            locationBody(REGIONAL_CARACAS_FIXTURE, { name: 'Sede Norte' }),
          )
          .expect(201)
      ).body as { id: string }
    ).id;
    tokens.ADMIN = a.adminToken;
    for (const role of [ClinicRole.DENTIST, ClinicRole.RECEPTION]) {
      const member = await seedMember(raw, a, role);
      tokens[role] = await loginAs(app, a.host, member.email);
      if (role === ClinicRole.DENTIST) dentistId = member.userId;
      if (role === ClinicRole.RECEPTION) {
        receptionId = member.userId;
        receptionOnlyNorte = (
          await app.get(TokenService).issue({
            sub: member.userId,
            tenantId: a.tenantId,
            role: ClinicRole.RECEPTION,
            loc: [norte],
            tv: 0,
          })
        ).accessToken;
      }
    }
    sourcesA = await sources(a);
    sourcesB = await sources(b);
  }, 120_000);

  afterAll(async () => {
    await app.close();
    await raw.$disconnect();
  });

  describe('catálogo «¿Cómo nos conoció?»', () => {
    it('la clínica nace con las 9 fuentes y todo el personal las lee', async () => {
      const res = await reception().get('/patient-sources').expect(200);
      expect((res.body as Source[]).map((s) => [s.name, s.kind])).toEqual([
        ['Recomendación de paciente', 'PATIENT'],
        ['Instagram', 'CHANNEL'],
        ['Facebook', 'CHANNEL'],
        ['Google', 'CHANNEL'],
        ['Marketplace de reservas', 'CHANNEL'],
        ['Convenio/empresa', 'CHANNEL'],
        ['Profesional externo', 'EXTERNAL_PROFESSIONAL'],
        ['Paso por la sede', 'CHANNEL'],
        ['Otro', 'CHANNEL'],
      ]);
      await as(a, tokens.DENTIST!).get('/patient-sources').expect(200);
    });

    it('solo ADMIN crea y renombra (auditado, antes y después); nombre repetido 409', async () => {
      const denied = await reception()
        .post('/patient-sources', { name: 'Radio', kind: 'CHANNEL' })
        .expect(403);
      expect((denied.body as { message: string }).message).toBe(
        PATIENT_SOURCE_MESSAGES.adminOnly,
      );
      const created = (
        await admin()
          .post('/patient-sources', {
            name: '  Radio   local ',
            kind: 'CHANNEL',
          })
          .expect(201)
      ).body as Source;
      expect(created).toMatchObject({
        name: 'Radio local',
        kind: 'CHANNEL',
        isActive: true,
        systemKey: null,
      });
      const dup = await admin()
        .post('/patient-sources', { name: 'RADIO LOCAL', kind: 'CHANNEL' })
        .expect(409);
      expect((dup.body as { message: string }).message).toBe(
        PATIENT_SOURCE_MESSAGES.nameTaken,
      );
      await admin()
        .post('/patient-sources', { name: 'x', kind: 'CHANNEL' })
        .expect(400);
      await admin()
        .patch(`/patient-sources/${created.id}`, { name: 'Radio comunitaria' })
        .expect(200);
      const events = await raw.auditEvent.findMany({
        where: { tenantId: a.tenantId, resourceId: created.id },
        orderBy: { occurredAt: 'asc' },
        select: { action: true, resourceType: true, metadata: true },
      });
      expect(events).toMatchObject([
        {
          action: 'CREATE',
          resourceType: 'CLINIC_SETTINGS',
          metadata: { reason: 'PATIENT_SOURCE_CREATED' },
        },
        {
          action: 'UPDATE',
          resourceType: 'CLINIC_SETTINGS',
          metadata: {
            reason: 'PATIENT_SOURCE_UPDATED',
            configChange: {
              before: { name: 'Radio local' },
              after: { name: 'Radio comunitaria' },
            },
          },
        },
      ]);
    });
  });

  describe('alta y edición', () => {
    it('recepción da de alta con «Recomendación de paciente» y el referente: la ficha del referente dice «Ha recomendado a N»', async () => {
      const ana = await createPatient({
        firstName: 'Ana',
        lastName: 'Rodríguez',
      });
      expect(ana).toMatchObject({
        sourceId: null,
        referredByPatientId: null,
        referredByName: null,
      });
      const luis = await createPatient({
        firstName: 'Luis',
        lastName: 'Pérez',
        sourceId: sourcesA.PATIENT_REFERRAL.id,
        referredByPatientId: ana.id,
      });
      expect(luis).toMatchObject({
        sourceId: sourcesA.PATIENT_REFERRAL.id,
        referredByPatientId: ana.id,
      });
      const referrer = await acquisitionOf(ana.id);
      expect(referrer.referrals.count).toBe(1);
      expect(referrer.referrals.recent).toEqual([
        expect.objectContaining({ id: luis.id, fullName: 'Luis Pérez' }),
      ]);
      expect(await acquisitionOf(luis.id)).toMatchObject({
        source: { name: 'Recomendación de paciente', kind: 'PATIENT' },
        referredByPatient: { id: ana.id, fullName: 'Ana Rodríguez' },
        referredByName: null,
        referrals: { count: 0, recent: [] },
      });
    });

    it('un profesional externo con su nombre; editar a Instagram lo vacía y deja el antes/después', async () => {
      const p = await createPatient({
        lastName: 'Derivada',
        sourceId: sourcesA.EXTERNAL_PROFESSIONAL.id,
        referredByName: 'Dra. Carmen Rojas',
      });
      expect(p.referredByName).toBe('Dra. Carmen Rojas');
      const edited = (
        await reception()
          .patch(`/patients/${p.id}`, { sourceId: sourcesA.INSTAGRAM.id })
          .expect(200)
      ).body as PatientBody;
      expect(edited).toMatchObject({
        sourceId: sourcesA.INSTAGRAM.id,
        referredByName: null,
      });
      const event = await raw.auditEvent.findFirstOrThrow({
        where: {
          tenantId: a.tenantId,
          resourceId: p.id,
          action: 'UPDATE',
          metadata: { path: ['reason'], equals: 'PATIENT_ACQUISITION_CHANGED' },
        },
        select: { patientId: true, metadata: true },
      });
      expect(event.patientId).toBe(p.id);
      expect(event.metadata).toMatchObject({
        configChange: {
          before: { source: 'Profesional externo' },
          after: { source: 'Instagram' },
        },
      });
      expect(JSON.stringify(event.metadata)).not.toContain('Carmen');
    });

    it('la fuente o el referente de otra clínica es 400 y el paciente queda igual; nadie se recomienda a sí mismo', async () => {
      const ana = await createPatient({ lastName: 'Base' });
      const ajena = (
        await as(b, b.adminToken)
          .post('/patients', {
            firstName: 'Ajena',
            lastName: 'Otra',
            docType: 'OTHER',
            sex: 'UNSPECIFIED',
          })
          .expect(201)
      ).body as PatientBody;
      const foreignReferrer = await createPatient(
        {
          sourceId: sourcesA.PATIENT_REFERRAL.id,
          referredByPatientId: ajena.id,
        },
        reception(),
        400,
      );
      expect(foreignReferrer.message).toBe(
        ACQUISITION_MESSAGES.referrerNotFound,
      );
      const foreignSource = await createPatient(
        { sourceId: sourcesB.INSTAGRAM.id },
        reception(),
        400,
      );
      expect(foreignSource.message).toBe(ACQUISITION_MESSAGES.sourceNotFound);
      for (const body of [
        { sourceId: sourcesB.INSTAGRAM.id },
        {
          sourceId: sourcesA.PATIENT_REFERRAL.id,
          referredByPatientId: ajena.id,
        },
        { sourceId: sourcesA.PATIENT_REFERRAL.id, referredByPatientId: ana.id },
      ]) {
        await reception().patch(`/patients/${ana.id}`, body).expect(400);
      }
      expect(
        await raw.patient.findUniqueOrThrow({
          where: { id: ana.id },
          select: { sourceId: true, referredByPatientId: true },
        }),
      ).toEqual({ sourceId: null, referredByPatientId: null });
      // Un nombre con una fuente que no es de profesional, también 400.
      await createPatient(
        { sourceId: sourcesA.INSTAGRAM.id, referredByName: 'Dr. Luis Pérez' },
        reception(),
        400,
      );
    });

    it('desactivar una fuente la quita del alta pero el paciente la conserva', async () => {
      const kept = await createPatient({
        lastName: 'Marketplace',
        sourceId: sourcesA.BOOKING_MARKETPLACE.id,
      });
      await admin()
        .patch(`/patient-sources/${sourcesA.BOOKING_MARKETPLACE.id}`, {
          isActive: false,
        })
        .expect(200);
      try {
        const active = (await reception().get('/patient-sources').expect(200))
          .body as Source[];
        expect(active.map((s) => s.id)).not.toContain(
          sourcesA.BOOKING_MARKETPLACE.id,
        );
        const all = (
          await reception()
            .get('/patient-sources', { includeInactive: true })
            .expect(200)
        ).body as Source[];
        expect(
          all.find((s) => s.id === sourcesA.BOOKING_MARKETPLACE.id),
        ).toMatchObject({
          isActive: false,
        });
        const blocked = await createPatient(
          { sourceId: sourcesA.BOOKING_MARKETPLACE.id },
          reception(),
          400,
        );
        expect(blocked.message).toBe(ACQUISITION_MESSAGES.sourceInactive);
        // Editar otros datos del que la tiene no la toca.
        const edited = (
          await reception()
            .patch(`/patients/${kept.id}`, { notes: 'Prefiere la tarde' })
            .expect(200)
        ).body as PatientBody;
        expect(edited.sourceId).toBe(sourcesA.BOOKING_MARKETPLACE.id);
        expect((await acquisitionOf(kept.id)).source).toMatchObject({
          isActive: false,
        });
      } finally {
        await admin()
          .patch(`/patient-sources/${sourcesA.BOOKING_MARKETPLACE.id}`, {
            isActive: true,
          })
          .expect(200);
      }
    });

    it('un prospecto de Instagram que se convierte en paciente nace con la fuente Instagram; uno de WhatsApp, sin fuente', async () => {
      const convert = async (channel: string, phone: string) => {
        const lead = (
          await reception()
            .post('/leads', {
              fullName: `Rosa ${channel}`,
              phone,
              channel,
              locationId: principal,
            })
            .expect(201)
        ).body as { id: string };
        const converted = (
          await reception()
            .post(`/leads/${lead.id}/convert`, { lastName: 'Medina' })
            .expect(200)
        ).body as { patientId: string };
        return raw.patient.findUniqueOrThrow({
          where: { id: converted.patientId },
          select: { sourceId: true },
        });
      };
      expect(await convert('INSTAGRAM', '0414 7210001')).toEqual({
        sourceId: sourcesA.INSTAGRAM.id,
      });
      expect(await convert('WHATSAPP', '0414 7210002')).toEqual({
        sourceId: null,
      });
    });
  });

  describe('informe de captación', () => {
    let ig: string[];
    let referrer: string;

    beforeAll(async () => {
      // 3 de Instagram con 100.000 VES (la moneda de la sede) cobrados en la
      // principal; un abono anulado que no cuenta; 1 de Google sin abonos; 1
      // sin fuente ni citas; y en Norte uno recomendado, cobrado en USD.
      ig = [
        await octoberPatient(
          'Instagram 1',
          { sourceId: sourcesA.INSTAGRAM.id },
          principal,
        ),
        await octoberPatient(
          'Instagram 2',
          { sourceId: sourcesA.INSTAGRAM.id },
          principal,
        ),
        await octoberPatient(
          'Instagram 3',
          { sourceId: sourcesA.INSTAGRAM.id },
          principal,
        ),
      ];
      await pay(ig[0], 50_000);
      await pay(ig[1], 30_000);
      await pay(ig[2], 20_000);
      await pay(ig[2], 9_999, { voided: true });
      await octoberPatient(
        'Google',
        { sourceId: sourcesA.GOOGLE.id },
        principal,
      );
      await octoberPatient('Sin fuente', {}, null);
      referrer = ig[0];
      const norteP = await octoberPatient(
        'Norte',
        {
          sourceId: sourcesA.PATIENT_REFERRAL.id,
          referredByPatientId: referrer,
        },
        norte,
      );
      await pay(norteP, 25.5, { currency: 'USD', locationId: norte });
    }, 60_000);

    it('las cifras por fuente y moneda: los anulados no cuentan y los sin fuente salen como «Sin dato»', async () => {
      const r = await reportOf();
      expect(rowOf(r, 'Instagram')).toMatchObject({
        newPatients: 3,
        payingPatients: 3,
        collected: [{ currency: 'VES', amount: 100_000 }],
      });
      expect(rowOf(r, 'Google')).toMatchObject({
        newPatients: 1,
        payingPatients: 0,
        collected: [],
      });
      expect(rowOf(r, 'Sin dato')).toMatchObject({
        sourceId: null,
        newPatients: 1,
      });
      expect(r.topReferrers[0]).toMatchObject({
        patientId: referrer,
        referred: 1,
        collected: [{ currency: 'USD', amount: 25.5 }],
      });
      expect(r.currencies).toEqual(['USD', 'VES']);
    });

    it('por sede: la principal y la Norte por separado; quien solo ve Norte, solo Norte', async () => {
      const main = await reportOf({ locationId: principal });
      expect(rowOf(main, 'Instagram')?.newPatients).toBe(3);
      expect(rowOf(main, 'Sin dato')).toBeUndefined();
      expect(main.totals.collected).toEqual([
        { currency: 'VES', amount: 100_000 },
      ]);
      const north = await reportOf({ locationId: norte });
      expect(north.totals).toMatchObject({
        newPatients: 1,
        collected: [{ currency: 'USD', amount: 25.5 }],
      });
      await raw.clinicMembership.updateMany({
        where: { tenantId: a.tenantId, userId: receptionId },
        data: { extraPermissions: [ExtraPermission.FINANCIAL_REPORTS_VIEW] },
      });
      try {
        const restricted = await reportOf({}, as(a, receptionOnlyNorte));
        expect(restricted.totals.newPatients).toBe(1);
        expect(restricted.options.locations.map((l) => l.id)).toEqual([norte]);
        await as(a, receptionOnlyNorte)
          .get('/reports/acquisition', { ...OCTOBER, locationId: principal })
          .expect(403);
      } finally {
        await raw.clinicMembership.updateMany({
          where: { tenantId: a.tenantId, userId: receptionId },
          data: { extraPermissions: [] },
        });
      }
    });

    it('solo ADMIN, o recepción con FINANCIAL_REPORTS_VIEW; el CSV, solo ADMIN', async () => {
      for (const role of [ClinicRole.RECEPTION, ClinicRole.DENTIST]) {
        const res = await as(a, tokens[role]!)
          .get('/reports/acquisition', OCTOBER)
          .expect(403);
        expect((res.body as { message: string }).message).toBe(
          ACQUISITION_FORBIDDEN_MESSAGE,
        );
      }
      await raw.clinicMembership.updateMany({
        where: { tenantId: a.tenantId, userId: receptionId },
        data: { extraPermissions: [ExtraPermission.FINANCIAL_REPORTS_VIEW] },
      });
      try {
        const r = await reportOf({}, reception());
        expect(rowOf(r, 'Instagram')?.newPatients).toBe(3);
        const csv = await reception()
          .get('/reports/acquisition.csv', OCTOBER)
          .expect(403);
        expect((csv.body as { message: string }).message).toBe(
          ACQUISITION_CSV_FORBIDDEN_MESSAGE,
        );
      } finally {
        await raw.clinicMembership.updateMany({
          where: { tenantId: a.tenantId, userId: receptionId },
          data: { extraPermissions: [] },
        });
      }
      const csv = await admin()
        .get('/reports/acquisition.csv', OCTOBER)
        .expect(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
      expect(csv.text).toContain('"Instagram","Canal","Activa",3,3,');
      expect(csv.text).not.toContain('Instagram 1');
      const audited = await raw.auditEvent.findMany({
        where: {
          tenantId: a.tenantId,
          metadata: { path: ['reason'], equals: 'ACQUISITION_REPORT' },
        },
        select: { action: true },
      });
      expect(new Set(audited.map((e) => e.action))).toEqual(
        new Set(['VIEW', 'EXPORT']),
      );
    });

    it('un período inválido o de más de 24 meses es 400', async () => {
      await admin()
        .get('/reports/acquisition', { from: '2026-10-31', to: '2026-10-01' })
        .expect(400);
      await admin()
        .get('/reports/acquisition', { from: '2024-01-01', to: '2026-10-01' })
        .expect(400);
    });
  });

  describe('aislamiento entre clínicas', () => {
    // ISOLATION_COVERS: PATCH /patient-sources/:id
    // ISOLATION_COVERS: GET /patients/:id/acquisition
    it('B no renombra ni desactiva una fuente de A, ni lee la captación de un paciente de A (404)', async () => {
      const ana = await createPatient({ lastName: 'De A' });
      await as(b, b.adminToken)
        .patch(`/patient-sources/${sourcesA.GOOGLE.id}`, { isActive: false })
        .expect(404);
      await as(b, b.adminToken)
        .get(`/patients/${ana.id}/acquisition`)
        .expect(404);
      expect(
        await raw.patientSource.findUniqueOrThrow({
          where: { id: sourcesA.GOOGLE.id },
          select: { isActive: true, name: true },
        }),
      ).toEqual({ isActive: true, name: 'Google' });
    });

    it('B con la sede de A en el informe y en el CSV: 403; su informe no ve a los pacientes de A', async () => {
      for (const path of ['/reports/acquisition', '/reports/acquisition.csv']) {
        const res = await as(b, b.adminToken)
          .get(path, { ...OCTOBER, locationId: principal })
          .expect(403);
        expect((res.body as { message: string }).message).toBe(
          'No tienes acceso a esta sede.',
        );
      }
      const own = (
        await as(b, b.adminToken)
          .get('/reports/acquisition', { ...OCTOBER, locationId: bLocation })
          .expect(200)
      ).body as AcquisitionReport;
      expect(own.totals.newPatients).toBe(0);
      const all = (
        await as(b, b.adminToken)
          .get('/reports/acquisition', OCTOBER)
          .expect(200)
      ).body as AcquisitionReport;
      expect(all.totals.newPatients).toBe(0);
    });
  });
});
