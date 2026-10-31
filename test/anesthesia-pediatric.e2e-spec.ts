import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
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

// DX-420 · máximos pediátricos, edad mínima, reducción por sedación y tope de
// epinefrina, de punta a punta con Postgres: catálogo sugerido con los
// valores de la AAPD y la epinefrina por carpule, niño de 20 kg con
// lidocaína (88 mg), articaína a los 3 años (409 + motivo sellado y
// auditado), sedación del mismo día (−30 %), cardiópata (0,04 mg) y
// aislamiento por clínica. DIRECT_URL solo para sembrar y leer.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const REASON = 'Sin alternativa en el gabinete, valorado con la familia';

interface Product {
  id: string;
  sampleCode: string | null;
  mlPerCarpule: number;
  pediatricMaxMgPerKg: number | null;
  minAgeYears: number | null;
  epinephrineMgPerCarpule: number | null;
}

interface Summary {
  rulesVersion: string;
  percent: number | null;
  alerts: { code: string; severity: string; message: string; source: string }[];
  byAnesthetic: {
    maxMg: number | null;
    maxMgPerKg: number;
    maxSource: string;
    percent: number | null;
  }[];
  adjustment: { pediatric: boolean; sedation: boolean; factor: number };
  epinephrine: {
    totalMg: number;
    maxMg: number;
    cardiac: boolean | null;
    level: string;
  };
  remaining: {
    mg: number;
    carpules: number;
    mlPerCarpule: number;
    limitedBy: string;
  } | null;
}

describe('Anestesia: pediatría, edad mínima, sedación y epinefrina (DX-420, e2e)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let dentist: { token: string; userId: string };
  let catalog: Product[];
  let catalogB: Product[];

  const http = () => request(app.getHttpServer());
  function call(
    clinic: Clinic,
    verb: 'get' | 'post' | 'patch',
    path: string,
    token: string,
  ) {
    return http()
      [verb](`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${token}`);
  }
  const anesthesia = (patientId: string, entryId: string) =>
    `/patients/${patientId}/clinical-entries/${entryId}/anesthesia`;
  const byCode = (code: string) =>
    catalog.find((p) => p.sampleCode === code) as Product;
  const codes = (s: { alerts: { code: string }[] }) =>
    s.alerts.map((x) => x.code);

  async function patientWithEntry(
    name: string,
    birthDate: string,
    weightKg: number,
    conditions: Prisma.InputJsonValue = [],
  ): Promise<{ patient: string; entry: string }> {
    const patient = await raw.patient.create({
      data: {
        tenantId: a.tenantId,
        firstName: name,
        lastName: 'Prueba',
        birthDate: new Date(birthDate),
      },
    });
    await raw.medicalHistoryVersion.create({
      data: {
        tenantId: a.tenantId,
        patientId: patient.id,
        version: 1,
        vitalSigns: { peso: weightKg },
        conditions,
        safetyFlags: {},
        hasCriticalAlert: false,
        createdById: a.adminUserId,
      },
    });
    const res = await call(
      a,
      'post',
      `/patients/${patient.id}/clinical-entries`,
      dentist.token,
    )
      .send({ notes: 'Tratamiento' })
      .expect(201);
    return { patient: patient.id, entry: (res.body as { id: string }).id };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx420-a');
    b = await registerClinic(app, 'dx420-b');
    const member = await seedMember(raw, a, 'DENTIST');
    dentist = {
      token: await loginAs(app, a.host, member.email),
      userId: member.userId,
    };
    catalog = (
      await call(a, 'post', '/anesthetics/samples', a.adminToken).expect(201)
    ).body as Product[];
    catalogB = (
      await call(b, 'post', '/anesthetics/samples', b.adminToken).expect(201)
    ).body as Product[];
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await app.close();
  });

  it('los sugeridos traen el máximo pediátrico, la edad mínima y la epinefrina por carpule', () => {
    expect(
      [
        'LIDOCAINE_2_EPI',
        'ARTICAINE_4_EPI',
        'MEPIVACAINE_3',
        'BUPIVACAINE_05_EPI',
      ].map((code) => {
        const p = byCode(code);
        return [
          p.pediatricMaxMgPerKg,
          p.minAgeYears,
          p.epinephrineMgPerCarpule,
        ];
      }),
    ).toEqual([
      [4.4, null, 0.018],
      [null, 4, 0.017],
      [4.4, null, 0],
      [null, 12, 0.009],
    ]);
  });

  it('el ADMIN los revisa; cambiar el volumen recalcula la epinefrina; fuera de rango es 400', async () => {
    const created = await call(a, 'post', '/anesthetics', a.adminToken)
      .send({
        name: 'Lidocaína 2 % con epinefrina 1:80.000',
        activeIngredient: 'Lidocaína',
        concentrationPct: 2,
        vasoconstrictor: 'Epinefrina 1:80.000',
        mlPerCarpule: 1.8,
        maxMgPerKg: 7,
        maxAbsoluteMg: 500,
        pediatricMaxMgPerKg: 4.4,
      })
      .expect(201);
    const product = created.body as Product;
    expect(product.epinephrineMgPerCarpule).toBe(0.0225);
    expect(product.minAgeYears).toBeNull();
    const patched = await call(
      a,
      'patch',
      `/anesthetics/${product.id}`,
      a.adminToken,
    )
      .send({ mlPerCarpule: 2.2, minAgeYears: 2 })
      .expect(200);
    expect(patched.body).toEqual(
      expect.objectContaining({
        epinephrineMgPerCarpule: 0.0275,
        minAgeYears: 2,
      }),
    );
    await call(a, 'patch', `/anesthetics/${product.id}`, a.adminToken)
      .send({ minAgeYears: 40 })
      .expect(400);
    await call(a, 'patch', `/anesthetics/${product.id}`, a.adminToken)
      .send({ active: false })
      .expect(200);
  });

  it('niño de 20 kg con lidocaína: máximo 4,4 mg/kg = 88 mg con la fuente AAPD y «quedan»', async () => {
    const { patient, entry } = await patientWithEntry('Leo', '2018-05-10', 20);
    const res = await call(
      a,
      'post',
      `${anesthesia(patient, entry)}/check`,
      dentist.token,
    )
      .send({ anestheticId: byCode('LIDOCAINE_2_EPI').id, carpules: 1 })
      .expect(200);
    const summary = (res.body as { summary: Summary }).summary;
    expect(summary.rulesVersion).toBe('ANESTHESIA_DOSE_V3');
    expect(summary.byAnesthetic[0]).toEqual(
      expect.objectContaining({ maxMg: 88, maxMgPerKg: 4.4, percent: 41 }),
    );
    expect(summary.byAnesthetic[0].maxSource).toContain('AAPD');
    expect(summary.remaining).toEqual(
      expect.objectContaining({ mg: 52, carpules: 1.25, mlPerCarpule: 1.8 }),
    );
    expect(summary.epinephrine).toEqual(
      expect.objectContaining({ totalMg: 0.018, maxMg: 0.2, cardiac: false }),
    );
  });

  it('articaína a los 3 años: 409 por edad mínima; con motivo se guarda, sellado y auditado sin textos', async () => {
    const { patient, entry } = await patientWithEntry('Ada', '2023-03-01', 14);
    const body = {
      anestheticId: byCode('ARTICAINE_4_EPI').id,
      carpules: 0.5,
      technique: 'INFILTRATION',
    };
    const conflict = await call(
      a,
      'post',
      anesthesia(patient, entry),
      dentist.token,
    )
      .send(body)
      .expect(409);
    const c = conflict.body as {
      message: string;
      safetyAlerts: Summary['alerts'];
    };
    expect(c.message).toContain('menores de 4 años');
    const ageAlert = c.safetyAlerts.find((x) => x.code === 'AGE_BELOW_MINIMUM');
    expect(ageAlert?.severity).toBe('BLOCKING');
    expect(ageAlert?.source).toContain('AAPD');
    const saved = await call(
      a,
      'post',
      anesthesia(patient, entry),
      dentist.token,
    )
      .send({ ...body, overrideReason: REASON })
      .expect(201);
    const record = saved.body as {
      id: string;
      overrideReason: string;
      minAgeYears: number;
    };
    expect(record).toEqual(
      expect.objectContaining({ overrideReason: REASON, minAgeYears: 4 }),
    );
    const events = await raw.auditEvent.findMany({
      where: {
        resourceType: 'ANESTHESIA_ADMINISTRATION',
        resourceId: record.id,
      },
    });
    expect(events).toHaveLength(1);
    expect(
      (events[0].metadata as { anesthesiaSafety: { blocking: string[] } })
        .anesthesiaSafety.blocking,
    ).toEqual(['AGE_BELOW_MINIMUM']);
    expect(JSON.stringify(events[0])).not.toContain(REASON);
  });

  it('con hoja de sedación el mismo día el máximo baja un 30 % y dice por qué', async () => {
    const { patient, entry } = await patientWithEntry('Sol', '2018-05-10', 20);
    await raw.sedationRecord.create({
      data: {
        tenantId: a.tenantId,
        patientId: patient,
        clinicalEntryId: entry,
        templateVersion: 'SEDATION_V1',
        rulesVersion: 'SEDATION_RULES_V1',
        vitalsIntervalMinutes: 5,
        grade: 'MINIMAL',
        consentConfirmed: true,
        authorId: dentist.userId,
        assessedAt: new Date(),
      },
    });
    const res = await call(
      a,
      'post',
      `${anesthesia(patient, entry)}/check`,
      dentist.token,
    )
      .send({ anestheticId: byCode('LIDOCAINE_2_EPI').id, carpules: 1 })
      .expect(200);
    const summary = (res.body as { summary: Summary }).summary;
    expect(summary.byAnesthetic[0].maxMg).toBe(61.6);
    expect(summary.adjustment).toEqual(
      expect.objectContaining({ sedation: true, factor: 0.7 }),
    );
    expect(
      summary.alerts.find((x) => x.code === 'DOSE_REDUCED_SEDATION')?.message,
    ).toContain('30 %');
  });

  it('cardiópata en la anamnesis: tope 0,04 mg; 3 carpules → 409 y con motivo sella la epinefrina', async () => {
    const { patient, entry } = await patientWithEntry(
      'Ramón',
      '1955-01-01',
      80,
      [
        {
          codigo: 'CARDIOPATIA',
          etiqueta: 'Enfermedad cardíaca',
          estado: 'SI',
        },
      ],
    );
    const body = {
      anestheticId: byCode('LIDOCAINE_2_EPI').id,
      carpules: 3,
      technique: 'NERVE_BLOCK',
    };
    const conflict = await call(
      a,
      'post',
      anesthesia(patient, entry),
      dentist.token,
    )
      .send(body)
      .expect(409);
    const c = conflict.body as { summary: Summary; message: string };
    expect(codes(c.summary)).toContain('EPINEPHRINE_OVER_MAX');
    expect(c.summary.epinephrine).toEqual(
      expect.objectContaining({
        totalMg: 0.054,
        maxMg: 0.04,
        cardiac: true,
        level: 'EXCEEDED',
      }),
    );
    expect(c.message).toContain('0,054 mg de 0,04 mg');
    const saved = await call(
      a,
      'post',
      anesthesia(patient, entry),
      dentist.token,
    )
      .send({ ...body, overrideReason: REASON })
      .expect(201);
    expect(saved.body).toEqual(
      expect.objectContaining({
        epinephrineMg: 0.054,
        cumulativeEpinephrineMg: 0.054,
        epinephrineMgPerCarpule: 0.018,
        overrideReason: REASON,
      }),
    );
  });

  it('un anestésico de otra clínica no sirve para calcular (404)', async () => {
    const { patient, entry } = await patientWithEntry('Iris', '2018-05-10', 20);
    await call(a, 'post', `${anesthesia(patient, entry)}/check`, dentist.token)
      .send({ anestheticId: catalogB[0].id, carpules: 1 })
      .expect(404);
  });
});
