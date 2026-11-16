import { INestApplication } from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
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
import { fixedSedeDay } from './support/sede-clock';
import { addCivilDays, civilDateIn } from '../src/shared/time/civil-day';
import { ORTHO_CLOCK } from '../src/modules/orthodontics/domain/ports/ortho-repository.port';
import { ORTHO_BILLING_MESSAGES } from '../src/modules/orthodontics/domain/ortho-billing';
import {
  ORTHO_ALIGNER_FORBIDDEN_MESSAGE,
  ORTHO_FEE_FORBIDDEN_MESSAGE,
  ORTHO_READ_FORBIDDEN_MESSAGE,
} from '../src/modules/orthodontics/presentation/ortho.controller';

// DX-285 · Honorario del caso de ortodoncia, cargos en el plan, cuenta, marca
// «Ortodoncia: saldo vencido» en la agenda y en «En clínica», y alineadores.
// Todo por la API salvo las citas y la lectura de ítems y auditoría (`raw`).
//
// Reloj de la ortodoncia (ORTHO_CLOCK) MOVIBLE: empieza en el mediodía de ayer
// en Caracas y, para el saldo vencido, salta 45 días por delante del reloj
// real con el que se realizan los cargos (hora del servidor).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const SEDE = fixedSedeDay(1);
const TODAY = SEDE.day;
const ago = (days: number) => addCivilDays(TODAY, -days);
const DAY_MS = 86_400_000;
let clock: Date = SEDE.at;

const FEE = {
  total: 3_000_000,
  initial: 600_000,
  perVisit: 90_000,
  visitCount: 24,
  retention: 240_000,
};

interface ErrorBody {
  message: string;
}

interface AccountBody {
  caseId: string;
  billing: string;
  currency: string | null;
  treatmentPlanId: string | null;
  billed: number | null;
  paid: number | null;
  balance: number | null;
  remaining: number | null;
  overdue: number | null;
  hasOverdue: boolean;
  overdueAgeDays: number;
  overdueDays: number;
  visitsCharged: number;
  visitsDone: number;
  fee: { total: number; acceptedAt: string | null } | null;
}

interface AlignersBody {
  today: string;
  upperSeriesId: string | null;
  lowerSeriesId: string | null;
  series: {
    id: string;
    sequence: number;
    state: string;
    currentTray: number | null;
    lastDeliveredTray: number;
    estimatedEndOn: string | null;
    deliveries: {
      fromTray: number;
      toTray: number;
      deliveredOn: string;
      visitId: string | null;
    }[];
  }[];
}

interface OrthoFlag {
  hasOverdue: boolean;
  overdueDays: number | null;
}

const idOf = (res: request.Response): string => (res.body as { id: string }).id;

describe('Ortodoncia — cobro, cuenta y alineadores (DX-285, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: { token: string; userId: string };
  let reception: string;
  let assistant: string;
  let patient1: string;
  let patientB: string;
  let case1: string;
  let caseB: string;
  let planId: string;
  let mainLocationA: string;
  let visit3: { id: string; clinicalEntryId: string };
  let seriesId: string;
  let seriesB: string;

  const call = (
    clinic: Clinic,
    token: string,
    verb: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    body?: object,
    headers: Record<string, string> = {},
  ) => {
    const req = request(app.getHttpServer())
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
    for (const [k, v] of Object.entries(headers)) req.set(k, v);
    return body ? req.send(body) : req;
  };

  async function createPatient(
    clinic: Clinic,
    firstName: string,
    docNumber: string,
  ): Promise<string> {
    const res = await call(clinic, clinic.adminToken, 'post', '/patients', {
      firstName,
      lastName: 'Ortodoncia',
      docType: 'NATIONAL_ID',
      docNumber,
      sex: 'F',
      phone: '+584121234567',
    }).expect(201);
    return idOf(res);
  }

  const accountOf = async (token = dentist.token) =>
    (
      await call(
        a,
        token,
        'get',
        `/patients/${patient1}/ortho-cases/${case1}/account`,
      ).expect(200)
    ).body as AccountBody;

  beforeAll(async () => {
    app = await createE2eApp({
      override: (builder) =>
        builder.overrideProvider(ORTHO_CLOCK).useValue(() => clock),
    });
    await resetDatabase(raw);
    a = await registerClinic(app, 'orto-cobro-a');
    b = await registerClinic(app, 'orto-cobro-b');
    const d = await seedMember(raw, a, ClinicRole.DENTIST);
    dentist = { token: await loginAs(app, a.host, d.email), userId: d.userId };
    reception = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.RECEPTION)).email,
    );
    assistant = await loginAs(
      app,
      a.host,
      (await seedMember(raw, a, ClinicRole.ASSISTANT)).email,
    );
    for (const c of [a, b]) {
      await call(c, c.adminToken, 'put', '/ortho/settings', {
        enabled: true,
      }).expect(200);
    }
    patient1 = await createPatient(a, 'Valentina', '62000001');
    patientB = await createPatient(b, 'Otra', '62000003');
    mainLocationA = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: a.tenantId },
        orderBy: { createdAt: 'asc' },
      })
    ).id;
    const caseBody = {
      technique: 'ALIGNERS',
      startDate: ago(120),
      estimatedMonths: 24,
      plannedVisits: 24,
    };
    case1 = idOf(
      await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/ortho-cases`,
        caseBody,
      ).expect(201),
    );
    caseB = idOf(
      await call(
        b,
        b.adminToken,
        'post',
        `/patients/${patientB}/ortho-cases`,
        caseBody,
      ).expect(201),
    );
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('honorario', () => {
    it('un reparto que no suma el total da 400 en español', async () => {
      const res = await call(
        a,
        dentist.token,
        'put',
        `/patients/${patient1}/ortho-cases/${case1}/fee`,
        { ...FEE, retention: 239_999 },
      ).expect(400);
      expect((res.body as ErrorBody).message).toBe(
        ORTHO_BILLING_MESSAGES.feeSplit,
      );
    });

    it('3.000.000 VES con inicial de 600.000, 24 controles de 90.000 y retiro de 240.000 se guarda; auditado sin importes', async () => {
      const res = await call(
        a,
        dentist.token,
        'put',
        `/patients/${patient1}/ortho-cases/${case1}/fee`,
        FEE,
      ).expect(200);
      expect(res.body).toMatchObject({
        billing: 'PENDING',
        currency: 'VES',
        fee: { total: 3_000_000, visitCount: 24, acceptedAt: null },
      });
      const event = await raw.auditEvent.findFirstOrThrow({
        where: {
          tenantId: a.tenantId,
          resourceType: 'ORTHO_CASE',
          resourceId: case1,
          action: 'UPDATE',
        },
        orderBy: { occurredAt: 'desc' },
      });
      expect(event.metadata).toMatchObject({ reason: 'ORTHO_FEE_UPDATED' });
      expect(JSON.stringify(event.metadata)).not.toMatch(/3000000|600000/);
    });

    it('RECEPTION ve la cuenta pero no edita ni acepta el honorario (403 en español)', async () => {
      for (const [verb, path, body] of [
        ['put', `/patients/${patient1}/ortho-cases/${case1}/fee`, FEE],
        ['post', `/patients/${patient1}/ortho-cases/${case1}/fee/accept`],
      ] as const) {
        const res = await call(a, reception, verb, path, body).expect(403);
        expect((res.body as ErrorBody).message).toBe(
          ORTHO_FEE_FORBIDDEN_MESSAGE,
        );
      }
      await call(
        a,
        assistant,
        'put',
        `/patients/${patient1}/ortho-cases/${case1}/fee`,
        FEE,
      ).expect(403);
      const account = await accountOf(reception);
      expect(account).toMatchObject({ billing: 'PENDING', caseId: case1 });
      const list = await call(
        a,
        reception,
        'get',
        `/patients/${patient1}/ortho-cases/accounts`,
      ).expect(200);
      expect((list.body as AccountBody[]).map((x) => x.caseId)).toEqual([
        case1,
      ]);
      // Pero no el caso clínico.
      const cases = await call(
        a,
        reception,
        'get',
        `/patients/${patient1}/ortho-cases`,
      ).expect(403);
      expect((cases.body as ErrorBody).message).toBe(
        ORTHO_READ_FORBIDDEN_MESSAGE,
      );
    });

    it('aceptar crea en un plan nuevo la inicial (realizada), 24 controles y el retiro', async () => {
      const res = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/ortho-cases/${case1}/fee/accept`,
      ).expect(200);
      const account = res.body as AccountBody;
      expect(account).toMatchObject({
        billing: 'PLAN_ITEMS',
        billed: 600_000,
        paid: 0,
        balance: 600_000,
        remaining: 2_400_000,
        hasOverdue: false,
      });
      planId = account.treatmentPlanId!;
      const items = await raw.treatmentPlanItem.findMany({
        where: { planId, deletedAt: null },
      });
      expect(items).toHaveLength(26);
      expect(items.filter((i) => i.status === 'DONE')).toHaveLength(1);
      // El honorario ya no cambia.
      const again = await call(
        a,
        dentist.token,
        'put',
        `/patients/${patient1}/ortho-cases/${case1}/fee`,
        FEE,
      ).expect(409);
      expect((again.body as ErrorBody).message).toBe(
        ORTHO_BILLING_MESSAGES.feeAccepted,
      );
    });

    it('al registrar el control 3 de 24 el plan muestra 3 controles realizados (270.000 + inicial); la adenda no duplica el cargo', async () => {
      const visits: { id: string; clinicalEntryId: string }[] = [];
      for (const entryDate of [ago(60), ago(30), ago(2)]) {
        const res = await call(
          a,
          dentist.token,
          'post',
          `/patients/${patient1}/ortho-cases/${case1}/visits`,
          { entryDate, hygieneIndex: 1 },
        ).expect(201);
        visits.push(res.body as { id: string; clinicalEntryId: string });
      }
      visit3 = visits[2];
      const done = await raw.treatmentPlanItem.findMany({
        where: { planId, status: 'DONE', deletedAt: null },
        orderBy: { notes: 'asc' },
      });
      expect(done.map((i) => i.notes).sort()).toEqual([
        'Ortodoncia: control 1 de 24',
        'Ortodoncia: control 2 de 24',
        'Ortodoncia: control 3 de 24',
        'Ortodoncia: cuota inicial',
      ]);
      expect(done.reduce((s, i) => s + i.price.toNumber(), 0)).toBe(
        600_000 + 270_000,
      );
      await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/clinical-entries/${visit3.clinicalEntryId}/addenda`,
        { reason: 'Corrección', text: 'La higiene era regular, no buena.' },
      ).expect(201);
      const account = await accountOf();
      expect(account).toMatchObject({
        billed: 870_000,
        balance: 870_000,
        visitsCharged: 3,
        visitsDone: 3,
      });
      expect(
        await raw.treatmentPlanItem.count({
          where: { planId, status: 'DONE', deletedAt: null },
        }),
      ).toBe(4);
    });
  });

  describe('«Ortodoncia: saldo vencido» (reloj fijo 45 días después, umbral 30)', () => {
    let appointmentId: string;
    const listFlag = async (token: string): Promise<OrthoFlag | undefined> => {
      const res = await call(
        a,
        token,
        'get',
        `/appointments?from=${encodeURIComponent(
          new Date(Date.now() - DAY_MS).toISOString(),
        )}&to=${encodeURIComponent(new Date(Date.now() + DAY_MS).toISOString())}`,
      ).expect(200);
      return (res.body as { id: string; orthoBalance: OrthoFlag }[]).find(
        (x) => x.id === appointmentId,
      )?.orthoBalance;
    };
    const inClinicFlag = async (
      token: string,
    ): Promise<OrthoFlag | undefined> => {
      const res = await call(
        a,
        token,
        'get',
        '/appointments/in-clinic',
        undefined,
        {
          'X-Location-Id': mainLocationA,
        },
      ).expect(200);
      const body = res.body as {
        waiting: { appointmentId: string; orthoBalance: OrthoFlag }[];
      };
      return body.waiting.find((w) => w.appointmentId === appointmentId)
        ?.orthoBalance;
    };

    beforeAll(async () => {
      const now = new Date();
      appointmentId = (
        await raw.appointment.create({
          data: {
            tenantId: a.tenantId,
            locationId: mainLocationA,
            patientId: patient1,
            providerId: dentist.userId,
            start: now,
            end: new Date(now.getTime() + 30 * 60_000),
            status: 'ARRIVED',
            preArrivalStatus: 'SCHEDULED',
            arrivedAt: now,
          },
        })
      ).id;
    });

    afterAll(() => {
      clock = SEDE.at;
    });

    it('hoy: sin marca (lo realizado es de hoy)', async () => {
      expect(await listFlag(reception)).toEqual({
        hasOverdue: false,
        overdueDays: null,
      });
    });

    it('45 días después: la cita y «En clínica» muestran la marca, y la cuenta el vencido', async () => {
      clock = new Date(Date.now() + 45 * DAY_MS);
      for (const token of [reception, dentist.token]) {
        expect(await listFlag(token)).toEqual({
          hasOverdue: true,
          overdueDays: 45,
        });
      }
      expect(await inClinicFlag(reception)).toEqual({
        hasOverdue: true,
        overdueDays: 45,
      });
      const account = await accountOf(reception);
      expect(account).toMatchObject({
        hasOverdue: true,
        overdue: 870_000,
        overdueAgeDays: 45,
        overdueDays: 30,
      });
      // La marca de la agenda no lleva importes.
      const res = await call(
        a,
        reception,
        'get',
        '/appointments/in-clinic',
        undefined,
        {
          'X-Location-Id': mainLocationA,
        },
      );
      expect(JSON.stringify(res.body)).not.toContain('870000');
    });

    it('al registrar el abono la marca desaparece', async () => {
      await call(a, reception, 'post', `/treatment-plans/${planId}/payments`, {
        amount: 870_000,
        currency: 'VES',
        paidAt: civilDateIn(new Date(), 'America/Caracas'),
        method: 'TRANSFER',
      }).expect(201);
      expect(await listFlag(reception)).toEqual({
        hasOverdue: false,
        overdueDays: null,
      });
      expect(await inClinicFlag(reception)).toEqual({
        hasOverdue: false,
        overdueDays: null,
      });
      expect(await accountOf(reception)).toMatchObject({
        hasOverdue: false,
        overdue: 0,
        paid: 870_000,
        balance: 0,
      });
    });
  });

  describe('retiro', () => {
    it('al pasar a retención el retiro queda realizado', async () => {
      await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/ortho-cases/${case1}/status`,
        { status: 'RETENTION' },
      ).expect(200);
      const account = await accountOf();
      expect(account.billed).toBe(870_000 + 240_000);
    });
  });

  describe('alineadores', () => {
    it('ASSISTANT los lee; RECEPTION ni los lee ni registra entregas', async () => {
      await call(
        a,
        assistant,
        'get',
        `/patients/${patient1}/ortho-cases/${case1}/aligners`,
      ).expect(200);
      await call(
        a,
        reception,
        'get',
        `/patients/${patient1}/ortho-cases/${case1}/aligners`,
      ).expect(403);
      const res = await call(
        a,
        reception,
        'post',
        `/patients/${patient1}/ortho-cases/${case1}/aligner-series`,
        { arch: 'BOTH', brand: 'Marca X', totalTrays: 20, daysPerTray: 14 },
      ).expect(403);
      expect((res.body as ErrorBody).message).toBe(
        ORTHO_ALIGNER_FORBIDDEN_MESSAGE,
      );
      await call(
        a,
        assistant,
        'post',
        `/patients/${patient1}/ortho-cases/${case1}/aligner-series`,
        { arch: 'BOTH', brand: 'Marca X', totalTrays: 20, daysPerTray: 14 },
      ).expect(403);
    });

    it('20 bandejas a 14 días, entregas 1–4 y 5–8 (desde el control): la bandeja sale por fecha y no pasa de la última', async () => {
      const opened = (
        await call(
          a,
          dentist.token,
          'post',
          `/patients/${patient1}/ortho-cases/${case1}/aligner-series`,
          { arch: 'BOTH', brand: 'Marca X', totalTrays: 20, daysPerTray: 14 },
        ).expect(201)
      ).body as AlignersBody;
      seriesId = opened.series[0].id;
      expect(opened).toMatchObject({
        upperSeriesId: seriesId,
        lowerSeriesId: seriesId,
      });
      await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/ortho-cases/${case1}/aligner-series/${seriesId}/deliveries`,
        { fromTray: 1, toTray: 4, deliveredOn: ago(100) },
      ).expect(201);
      // Fuera de orden: 400 en español.
      const gap = await call(
        a,
        dentist.token,
        'post',
        `/patients/${patient1}/ortho-cases/${case1}/aligner-series/${seriesId}/deliveries`,
        { fromTray: 6, toTray: 8, deliveredOn: ago(50) },
      ).expect(400);
      expect((gap.body as ErrorBody).message).toBe(
        ORTHO_BILLING_MESSAGES.deliveryOrder(5),
      );
      // Desde el control de hace 2 días (su fecha por defecto).
      const view = (
        await call(
          a,
          dentist.token,
          'post',
          `/patients/${patient1}/ortho-cases/${case1}/aligner-series/${seriesId}/deliveries`,
          { fromTray: 5, toTray: 8, visitId: visit3.id },
        ).expect(201)
      ).body as AlignersBody;
      const s = view.series[0];
      expect(s.deliveries[1]).toMatchObject({
        fromTray: 5,
        deliveredOn: ago(2),
        visitId: visit3.id,
      });
      // Hoy (reloj de la sede): la 5 empezó hace 2 días (entrega tardía),
      // así que lleva la 5.
      expect(s).toMatchObject({
        state: 'IN_PROGRESS',
        currentTray: 5,
        lastDeliveredTray: 8,
      });
      // 60 días después la 8 ya terminó: «Sin bandejas: entregar».
      clock = new Date(SEDE.at.getTime() + 60 * DAY_MS);
      const later = (
        await call(
          a,
          dentist.token,
          'get',
          `/patients/${patient1}/ortho-cases/${case1}/aligners`,
        ).expect(200)
      ).body as AlignersBody;
      clock = SEDE.at;
      expect(later.series[0]).toMatchObject({
        state: 'NEEDS_DELIVERY',
        currentTray: 8,
      });
    });

    it('un refinamiento abre una serie nueva sin perder la anterior', async () => {
      const view = (
        await call(
          a,
          dentist.token,
          'post',
          `/patients/${patient1}/ortho-cases/${case1}/aligner-series`,
          {
            arch: 'UPPER',
            brand: 'Marca X',
            totalTrays: 6,
            daysPerTray: 7,
            refinementOfId: seriesId,
          },
        ).expect(201)
      ).body as AlignersBody;
      expect(view.series.map((s) => s.sequence)).toEqual([1, 2]);
      expect(view.upperSeriesId).toBe(view.series[1].id);
      expect(view.lowerSeriesId).toBe(seriesId);
    });
  });

  describe('aislamiento entre clínicas', () => {
    beforeAll(async () => {
      seriesB = (
        (
          await call(
            b,
            b.adminToken,
            'post',
            `/patients/${patientB}/ortho-cases/${caseB}/aligner-series`,
            {
              arch: 'LOWER',
              brand: 'Marca Y',
              totalTrays: 10,
              daysPerTray: 10,
            },
          ).expect(201)
        ).body as AlignersBody
      ).series[0].id;
    });

    // ISOLATION_COVERS: GET /patients/:patientId/ortho-cases/accounts
    // ISOLATION_COVERS: GET /patients/:patientId/ortho-cases/:caseId/account
    // ISOLATION_COVERS: PUT /patients/:patientId/ortho-cases/:caseId/fee
    // ISOLATION_COVERS: POST /patients/:patientId/ortho-cases/:caseId/fee/accept
    // ISOLATION_COVERS: GET /patients/:patientId/ortho-cases/:caseId/aligners
    // ISOLATION_COVERS: POST /patients/:patientId/ortho-cases/:caseId/aligner-series
    // ISOLATION_COVERS: POST /patients/:patientId/ortho-cases/:caseId/aligner-series/:seriesId/deliveries
    it('B → 404 sobre el paciente, el caso y la serie de A; nada de A cambia', async () => {
      const chargesBefore = await raw.orthoCaseCharge.count({
        where: { caseId: case1 },
      });
      const seriesBefore = await raw.orthoAlignerSeries.count({
        where: { caseId: case1 },
      });
      const deliveriesBefore = await raw.orthoAlignerDelivery.count({
        where: { caseId: case1 },
      });
      const series = {
        arch: 'BOTH',
        brand: 'X',
        totalTrays: 5,
        daysPerTray: 7,
      };
      const delivery = { fromTray: 9, toTray: 10 };
      const tries: [
        verb: 'get' | 'post' | 'put',
        path: string,
        body?: object,
      ][] = [
        ['get', `/patients/${patient1}/ortho-cases/accounts`],
        ['get', `/patients/${patient1}/ortho-cases/${case1}/account`],
        ['put', `/patients/${patient1}/ortho-cases/${case1}/fee`, FEE],
        ['post', `/patients/${patient1}/ortho-cases/${case1}/fee/accept`],
        ['get', `/patients/${patient1}/ortho-cases/${case1}/aligners`],
        [
          'post',
          `/patients/${patient1}/ortho-cases/${case1}/aligner-series`,
          series,
        ],
        [
          'post',
          `/patients/${patient1}/ortho-cases/${case1}/aligner-series/${seriesId}/deliveries`,
          delivery,
        ],
        // El paciente de B con el caso de A.
        ['get', `/patients/${patientB}/ortho-cases/${case1}/account`],
        ['put', `/patients/${patientB}/ortho-cases/${case1}/fee`, FEE],
        ['post', `/patients/${patientB}/ortho-cases/${case1}/fee/accept`],
        ['get', `/patients/${patientB}/ortho-cases/${case1}/aligners`],
        [
          'post',
          `/patients/${patientB}/ortho-cases/${case1}/aligner-series`,
          series,
        ],
        // El caso de B con la serie de A.
        [
          'post',
          `/patients/${patientB}/ortho-cases/${caseB}/aligner-series/${seriesId}/deliveries`,
          delivery,
        ],
      ];
      for (const [verb, path, body] of tries) {
        const res = await call(b, b.adminToken, verb, path, body);
        expect([verb, path, res.status]).toEqual([verb, path, 404]);
      }
      expect(
        await raw.orthoCaseCharge.count({ where: { caseId: case1 } }),
      ).toBe(chargesBefore);
      expect(
        await raw.orthoAlignerSeries.count({ where: { caseId: case1 } }),
      ).toBe(seriesBefore);
      expect(
        await raw.orthoAlignerDelivery.count({ where: { caseId: case1 } }),
      ).toBe(deliveriesBefore);
    });

    it('B con la serie o el control de A en el cuerpo: 400, sin filas nuevas', async () => {
      const refined = await call(
        b,
        b.adminToken,
        'post',
        `/patients/${patientB}/ortho-cases/${caseB}/aligner-series`,
        {
          arch: 'LOWER',
          brand: 'Marca Y',
          totalTrays: 4,
          daysPerTray: 7,
          refinementOfId: seriesId,
        },
      ).expect(400);
      expect((refined.body as ErrorBody).message).toBe(
        ORTHO_BILLING_MESSAGES.refinementNotFound,
      );
      const fromVisit = await call(
        b,
        b.adminToken,
        'post',
        `/patients/${patientB}/ortho-cases/${caseB}/aligner-series/${seriesB}/deliveries`,
        { fromTray: 1, toTray: 2, visitId: visit3.id },
      ).expect(400);
      expect((fromVisit.body as ErrorBody).message).toBe(
        ORTHO_BILLING_MESSAGES.visitNotFound,
      );
      expect(
        await raw.orthoAlignerSeries.count({ where: { caseId: caseB } }),
      ).toBe(1);
      expect(
        await raw.orthoAlignerDelivery.count({ where: { caseId: caseB } }),
      ).toBe(0);
    });

    it('la marca de B no ve los cargos de A', async () => {
      const res = await call(
        b,
        b.adminToken,
        'get',
        `/patients/${patientB}/ortho-cases/${caseB}/account`,
      ).expect(200);
      expect(res.body).toMatchObject({ billing: 'NONE', billed: null });
    });
  });
});
