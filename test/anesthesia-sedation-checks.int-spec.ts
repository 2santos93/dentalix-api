import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { Clinic, registerClinic, resetDatabase } from './support/e2e-fixtures';

// DX-427 (DB-064): la dosis, el acumulado y la hora de la anestesia y de la
// hoja de sedación también los comprueba la BASE, no solo la app. Cada regla
// se prueba con un INSERT crudo del ROL DE LA APP (dentalix_app bajo RLS, con
// `app.current_tenant`), que clona una fila VÁLIDA registrada por la API y
// cambia solo la columna a probar: así el error es el de esa regla.
// DIRECT_URL (owner) solo para sembrar la hoja de sedación y leer el catálogo.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const NEW_CHECKS = [
  ['anesthesia_administrations', 'anesthesia_administrations_dose_range'],
  ['anesthesia_administrations', 'anesthesia_administrations_dose_derived'],
  ['anesthesia_administrations', 'anesthesia_administrations_cumulative'],
  ['anesthesia_administrations', 'anesthesia_administrations_not_future'],
  ['sedation_records', 'sedation_records_not_future'],
  ['sedation_checklists', 'sedation_checklists_not_future'],
  [
    'sedation_agent_administrations',
    'sedation_agent_administrations_not_future',
  ],
  ['sedation_vitals', 'sedation_vitals_not_future'],
  ['sedation_discharges', 'sedation_discharges_not_future'],
] as const;

/** Mensaje y SQLSTATE de la guarda «anterior a la evolución». */
const BEFORE_ENTRY_STATE = 'Q4270';
const BEFORE_ENTRY_MESSAGE =
  'La hora no puede ser anterior a la fecha de la evolución.';

const minutes = (n: number) => `interval '${n} minutes'`;

function errorText(err: unknown): string {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    return `${err.message} ${JSON.stringify(err.meta ?? {})}`;
  }
  return String(err);
}

describe('anestesia y sedación: CHECK de dosis, acumulado y hora en la BD (DX-427, int)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let patientId: string;
  let entryId: string;
  let anesthesiaId: string;
  let sheetId: string;
  let vitalsId: string;

  const http = () => request(app.getHttpServer());
  const post = (path: string, body: object) =>
    http()
      .post(`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .send(body);

  /** SQL como dentalix_app con la clínica fijada (como la app). */
  function asApp(sql: string): Promise<number> {
    return appRole.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${clinic.tenantId}, true)`;
      return tx.$executeRawUnsafe(sql);
    });
  }

  async function rejection(sql: string): Promise<string> {
    try {
      await asApp(sql);
    } catch (err) {
      return errorText(err);
    }
    throw new Error('El INSERT debía fallar y pasó');
  }

  /**
   * INSERT … SELECT que copia la anestesia válida con nuevo id y las columnas
   * de `overrides` como expresiones SQL (pueden usar las de la fila: `src.`).
   */
  function cloneAnesthesia(overrides: Record<string, string>): string {
    const cols = [
      'tenantId',
      'patientId',
      'clinicalEntryId',
      'locationId',
      'anestheticId',
      'anestheticName',
      'activeIngredient',
      'concentrationPct',
      'vasoconstrictor',
      'mlPerCarpule',
      'maxMgPerKg',
      'maxAbsoluteMg',
      'pediatricMaxMgPerKg',
      'minAgeYears',
      'epinephrineMgPerCarpule',
      'epinephrineMg',
      'cumulativeEpinephrineMg',
      'carpules',
      'doseMg',
      'technique',
      'site',
      'lot',
      'administeredAt',
      'weightKg',
      'weightSource',
      'cumulativeMg',
      'cumulativePercent',
      'safetyRulesVersion',
      'safetyAlerts',
      'overrideReason',
      'authorId',
    ];
    const values = cols.map((c) => overrides[c] ?? `src."${c}"`);
    return `INSERT INTO "anesthesia_administrations" ("id", ${cols
      .map((c) => `"${c}"`)
      .join(', ')})
      SELECT '${randomUUID()}'::uuid, ${values.join(', ')}
      FROM "anesthesia_administrations" src
      WHERE src."id" = '${anesthesiaId}'::uuid`;
  }

  function agentInsert(administeredAt: string): string {
    return `INSERT INTO "sedation_agent_administrations"
      ("id", "tenantId", "sedationRecordId", "kind", "route", "n2oPercent",
       "flowLpm", "administeredAt", "authorId")
      VALUES ('${randomUUID()}', '${clinic.tenantId}', '${sheetId}',
        'NITROUS_OXIDE', 'INHALED', 30, 6, ${administeredAt},
        '${clinic.adminUserId}')`;
  }

  function vitalsInsert(takenAt: string, id: string = randomUUID()): string {
    return `INSERT INTO "sedation_vitals"
      ("id", "tenantId", "sedationRecordId", "phase", "takenAt", "spo2",
       "authorId")
      VALUES ('${id}', '${clinic.tenantId}', '${sheetId}', 'BASELINE',
        ${takenAt}, 98, '${clinic.adminUserId}')`;
  }

  function dischargeInsert(dischargedAt: string): string {
    return `INSERT INTO "sedation_discharges"
      ("id", "tenantId", "sedationRecordId", "criteria", "vitalsId",
       "dischargedAt", "handedOverToName", "handedOverToRelationship",
       "instructionsDelivered", "operatorId", "monitorId")
      VALUES ('${randomUUID()}', '${clinic.tenantId}', '${sheetId}', '[]',
        '${vitalsId}', ${dischargedAt}, 'Laura Ortiz', 'Madre', true,
        '${clinic.adminUserId}', '${clinic.adminUserId}')`;
  }

  function sheetInsert(
    entry: string,
    assessedAt: string,
    id: string = randomUUID(),
  ): string {
    return `INSERT INTO "sedation_records"
      ("id", "tenantId", "patientId", "clinicalEntryId", "templateVersion",
       "rulesVersion", "vitalsIntervalMinutes", "grade", "consentConfirmed",
       "authorId", "assessedAt")
      VALUES ('${id}', '${clinic.tenantId}', '${patientId}', '${entry}',
        'PLATFORM_V1', 'SEDATION_V1', 5, 'MINIMAL', true,
        '${clinic.adminUserId}', ${assessedAt})`;
  }

  function checklistInsert(checkedAt: string): string {
    return `INSERT INTO "sedation_checklists"
      ("id", "tenantId", "sedationRecordId", "items", "checkedAt", "authorId")
      VALUES ('${randomUUID()}', '${clinic.tenantId}', '${sheetId}', '[]',
        ${checkedAt}, '${clinic.adminUserId}')`;
  }

  async function newEntry(notes: string): Promise<string> {
    const res = await post(`/patients/${patientId}/clinical-entries`, {
      notes,
    }).expect(201);
    return (res.body as { id: string }).id;
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'dx427');
    const samples = await post('/anesthetics/samples', {}).expect(201);
    const lido = (samples.body as { id: string; sampleCode: string }[]).find(
      (p) => p.sampleCode === 'LIDOCAINE_2_EPI',
    )!.id;
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'Ana',
        lastName: 'Dosis',
        birthDate: new Date('1985-03-02'),
      },
    });
    patientId = patient.id;
    entryId = await newEntry('Endodoncia 36');
    const res = await post(
      `/patients/${patientId}/clinical-entries/${entryId}/anesthesia`,
      { anestheticId: lido, carpules: 2, technique: 'INFILTRATION' },
    ).expect(201);
    anesthesiaId = (res.body as { id: string }).id;

    // Hoja de sedación mínima de otra evolución (la siembra el owner: el
    // flujo completo ya lo cubre sedation.e2e-spec) y su toma basal.
    const sedationEntry = await newEntry('Sedación con N2O');
    sheetId = randomUUID();
    await raw.$executeRawUnsafe(
      sheetInsert(sedationEntry, `now() - ${minutes(30)}`, sheetId),
    );
    vitalsId = randomUUID();
    await raw.$executeRawUnsafe(
      vitalsInsert(`now() - ${minutes(20)}`, vitalsId),
    );
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await appRole.$disconnect();
    await app.close();
  });

  it('las reglas nuevas existen y están validadas (los registros existentes pasan)', async () => {
    const rows = await raw.$queryRaw<
      { table: string; name: string; validated: boolean }[]
    >`
      SELECT c.conrelid::regclass::text AS "table", c.conname AS "name",
             c.convalidated AS "validated"
      FROM pg_constraint c
      WHERE c.contype = 'c' AND c.conname = ANY(${NEW_CHECKS.map(([, n]) => n)})`;
    expect(
      rows.map((r) => [r.table.replace(/"/g, ''), r.name, r.validated]).sort(),
    ).toEqual(NEW_CHECKS.map(([t, n]) => [t, n, true]).sort());
  });

  describe('anestesia', () => {
    it('una copia válida pasa (incluida una hora 10 min adelantada por desfase de reloj)', async () => {
      await expect(asApp(cloneAnesthesia({}))).resolves.toBe(1);
      await expect(
        asApp(cloneAnesthesia({ administeredAt: `now() + ${minutes(10)}` })),
      ).resolves.toBe(1);
    });

    // Fila coherente en todo lo demás (dosis = carpules × ml × concentración
    // y acumulado = dosis) para que falle SOLO el rango: la copia del
    // catálogo de la fila no tiene CHECK propio en esta tabla.
    it.each([
      ['0', { concentrationPct: '0' }],
      ['-36', { concentrationPct: '-1' }],
      [
        '10020',
        { mlPerCarpule: '5.01', concentrationPct: '10', carpules: '20' },
      ],
    ])('dosis %s mg falla', async (dose, catalog: Record<string, string>) => {
      const text = await rejection(
        cloneAnesthesia({ ...catalog, doseMg: dose, cumulativeMg: dose }),
      );
      expect(text).toContain('23514');
      expect(text).toContain('anesthesia_administrations_dose_range');
    });

    it('la dosis máxima del dominio (20 carpules de 5 ml al 10 %: 10000 mg) pasa', async () => {
      await expect(
        asApp(
          cloneAnesthesia({
            mlPerCarpule: '5',
            concentrationPct: '10',
            carpules: '20',
            doseMg: '10000',
            cumulativeMg: '10000',
          }),
        ),
      ).resolves.toBe(1);
    });

    it('una dosis que no sale de carpules × ml × concentración falla', async () => {
      // 2 carpules de lidocaína al 2 % (1,8 ml) son 72 mg, no 500.
      const text = await rejection(
        cloneAnesthesia({ doseMg: '500', cumulativeMg: '500' }),
      );
      expect(text).toContain('anesthesia_administrations_dose_derived');
    });

    it('un acumulado menor que la propia dosis o negativo falla', async () => {
      const cases: Record<string, string>[] = [
        { cumulativeMg: '1' },
        { cumulativePercent: '-1' },
        { cumulativeEpinephrineMg: '0' },
      ];
      for (const overrides of cases) {
        const text = await rejection(cloneAnesthesia(overrides));
        expect(text).toContain('anesthesia_administrations_cumulative');
      }
    });

    it('una hora de administración futura respecto al registro falla', async () => {
      const text = await rejection(
        cloneAnesthesia({ administeredAt: `now() + ${minutes(60)}` }),
      );
      expect(text).toContain('anesthesia_administrations_not_future');
    });

    it('una hora anterior a la fecha de la evolución (más el margen) falla con su SQLSTATE', async () => {
      const text = await rejection(
        cloneAnesthesia({ administeredAt: `now() - interval '3 days'` }),
      );
      expect(text).toContain(BEFORE_ENTRY_STATE);
      // Dentro del margen (el mismo día civil, otra zona): pasa.
      await expect(
        asApp(
          cloneAnesthesia({ administeredAt: `now() - interval '20 hours'` }),
        ),
      ).resolves.toBe(1);
    });

    it('la API traduce la guarda a 400 en español (nunca 500)', async () => {
      const samples = await raw.anestheticProduct.findFirstOrThrow({
        where: { tenantId: clinic.tenantId, sampleCode: 'LIDOCAINE_2_EPI' },
      });
      const res = await post(
        `/patients/${patientId}/clinical-entries/${entryId}/anesthesia`,
        {
          anestheticId: samples.id,
          carpules: 1,
          technique: 'INFILTRATION',
          administeredAt: new Date(
            Date.now() - 3 * 24 * 3_600_000,
          ).toISOString(),
        },
      );
      expect(res.status).toBe(400);
      expect((res.body as { message: string }).message).toBe(
        BEFORE_ENTRY_MESSAGE,
      );
    });
  });

  describe('hoja de sedación', () => {
    it('fármaco, toma y egreso válidos pasan (con desfase de reloj de 10 min)', async () => {
      await expect(asApp(agentInsert(`now() - ${minutes(10)}`))).resolves.toBe(
        1,
      );
      await expect(asApp(agentInsert(`now() + ${minutes(10)}`))).resolves.toBe(
        1,
      );
      await expect(asApp(vitalsInsert('now()'))).resolves.toBe(1);
      await expect(asApp(checklistInsert('now()'))).resolves.toBe(1);
      await expect(asApp(dischargeInsert('now()'))).resolves.toBe(1);
    });

    it.each([
      ['fármaco', 'sedation_agent_administrations_not_future'],
      ['toma', 'sedation_vitals_not_future'],
      ['egreso', 'sedation_discharges_not_future'],
      ['valoración', 'sedation_records_not_future'],
      ['checklist', 'sedation_checklists_not_future'],
    ])('%s con hora futura falla', async (what, constraint) => {
      const future = `now() + ${minutes(60)}`;
      const sql: Record<string, () => Promise<string>> = {
        fármaco: () => Promise.resolve(agentInsert(future)),
        toma: () => Promise.resolve(vitalsInsert(future)),
        egreso: () => Promise.resolve(dischargeInsert(future)),
        valoración: async () =>
          sheetInsert(await newEntry('Sedación futura'), future),
        checklist: () => Promise.resolve(checklistInsert(future)),
      };
      const text = await rejection(await sql[what]());
      expect(text).toContain('23514');
      expect(text).toContain(constraint);
    });

    it('fármaco y toma anteriores a la fecha de la evolución fallan con su SQLSTATE', async () => {
      const old = `now() - interval '3 days'`;
      expect(await rejection(agentInsert(old))).toContain(BEFORE_ENTRY_STATE);
      expect(await rejection(vitalsInsert(old))).toContain(BEFORE_ENTRY_STATE);
    });

    it('la dosis 0 o absurda del fármaco ya fallaba (DX-407) y sigue fallando', async () => {
      for (const dose of ['0', '-5', '10001']) {
        const text = await rejection(
          `INSERT INTO "sedation_agent_administrations"
            ("id", "tenantId", "sedationRecordId", "kind", "drugName", "dose",
             "doseUnit", "route", "administeredAt", "authorId")
            VALUES ('${randomUUID()}', '${clinic.tenantId}', '${sheetId}',
              'ORAL', 'Midazolam', ${dose}, 'MG', 'ORAL', now(),
              '${clinic.adminUserId}')`,
        );
        expect(text).toContain('sedation_agent_administrations_kind_shape');
      }
    });
  });
});
