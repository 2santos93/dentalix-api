import { ConflictException, INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { Clinic, registerClinic, resetDatabase } from './support/e2e-fixtures';
import { AnesthesiaUseCases } from '../src/modules/anesthesia/application/use-cases/anesthesia.use-cases';
import {
  ANESTHESIA_REPOSITORY,
  type AnesthesiaRepository,
} from '../src/modules/anesthesia/domain/ports/anesthesia-repository.port';
import { doseWindowAround } from '../src/modules/anesthesia/domain/anesthesia-window';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';

// DX-418 contra Postgres: el acumulado de anestesia es del PACIENTE en 24 h y
// el registro bloquea al paciente. Dos registros simultáneos en DOS
// evoluciones (en DX-307 el bloqueo era de la evolución y pasaban los dos)
// que juntos superan el máximo: el segundo espera al primero, calcula con él
// y sin motivo es 409. La RLS deja fuera lo de otra clínica.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const appRole = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

const LIDO3 = { carpules: 3, technique: 'INFILTRATION' as const };

describe('anestesia: acumulado del paciente y bloqueo por paciente (DX-418, int)', () => {
  let app: INestApplication<App>;
  let a: Clinic;
  let b: Clinic;
  let lidoA: string;
  let lidoB: string;
  let uc: AnesthesiaUseCases;
  let repo: AnesthesiaRepository;
  let tenantContext: TenantContextService;
  let seq = 0;

  const http = () => request(app.getHttpServer());
  const post = (clinic: Clinic, path: string, body: object) =>
    http()
      .post(`/api/v1${path}`)
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`)
      .send(body);
  const anesthesia = (patientId: string, entryId: string) =>
    `/patients/${patientId}/clinical-entries/${entryId}/anesthesia`;

  /** Niño de 20 kg con dos evoluciones (máximo de lidocaína: 140 mg). */
  async function childWithTwoEntries(clinic: Clinic = a) {
    const patient = await raw.patient.create({
      data: {
        tenantId: clinic.tenantId,
        firstName: 'Niño',
        lastName: `Ventana${++seq}`,
        birthDate: new Date('2018-05-10'),
      },
    });
    await raw.medicalHistoryVersion.create({
      data: {
        tenantId: clinic.tenantId,
        patientId: patient.id,
        version: 1,
        vitalSigns: { peso: 20 },
        safetyFlags: {},
        hasCriticalAlert: false,
        createdById: clinic.adminUserId,
      },
    });
    const entries: string[] = [];
    for (const notes of ['Exodoncia 85', 'Exodoncia 75']) {
      const res = await post(
        clinic,
        `/patients/${patient.id}/clinical-entries`,
        { notes },
      ).expect(201);
      entries.push((res.body as { id: string }).id);
    }
    return { patientId: patient.id, e1: entries[0], e2: entries[1] };
  }

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    a = await registerClinic(app, 'dx418-a');
    b = await registerClinic(app, 'dx418-b');
    const lido = (clinic: Clinic) =>
      post(clinic, '/anesthetics/samples', {})
        .expect(201)
        .then(
          (res) =>
            (res.body as { id: string; sampleCode: string }[]).find(
              (p) => p.sampleCode === 'LIDOCAINE_2_EPI',
            )!.id,
        );
    lidoA = await lido(a);
    lidoB = await lido(b);
    uc = app.get(AnesthesiaUseCases);
    repo = app.get<AnesthesiaRepository>(ANESTHESIA_REPOSITORY);
    tenantContext = app.get(TenantContextService);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await raw.$disconnect();
    await appRole.$disconnect();
    await app.close();
  });

  it('el segundo registro (otra evolución) espera al primero bajo el bloqueo del paciente y sin motivo es 409', async () => {
    const { patientId, e1, e2 } = await childWithTwoEntries();
    const asA = <T>(fn: () => Promise<T>) => tenantContext.run(a.tenantId, fn);

    // El primero se queda DENTRO de su transacción (ya decidió, aún sin
    // confirmar) hasta que lo soltemos.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let entered!: () => void;
    const insideFirst = new Promise<void>((resolve) => (entered = resolve));
    const original = repo.record.bind(repo);
    const spy = jest
      .spyOn(repo, 'record')
      .mockImplementationOnce((p, e, w, build) =>
        original(p, e, w, async (prior) => {
          const row = await build(prior);
          entered();
          await gate;
          return row;
        }),
      );
    let secondPrior = -1;
    spy.mockImplementationOnce((p, e, w, build) =>
      original(p, e, w, (prior) => {
        secondPrior = prior.window.length;
        return build(prior);
      }),
    );

    const first = asA(() =>
      uc.record(
        patientId,
        e1,
        { ...LIDO3, anestheticId: lidoA },
        a.adminUserId,
      ),
    );
    await insideFirst;
    let secondSettled = false;
    const second = asA(() =>
      uc.record(
        patientId,
        e2,
        { ...LIDO3, anestheticId: lidoA },
        a.adminUserId,
      ),
    ).finally(() => {
      secondSettled = true;
    });
    const secondResult = second.catch((err: unknown) => err);

    // Mientras el primero no confirma, el segundo está esperando el bloqueo.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(secondSettled).toBe(false);

    release();
    expect((await first).cumulativePercent).toBe(77);
    const err = await secondResult;
    expect(err).toBeInstanceOf(ConflictException);
    expect(
      ((err as ConflictException).getResponse() as { message: string }).message,
    ).toContain('216 mg de 140 mg (154 %)');
    // Calculó CON el primero: lo leyó tras el bloqueo.
    expect(secondPrior).toBe(1);
    expect(
      await raw.anesthesiaAdministration.count({ where: { patientId } }),
    ).toBe(1);
    spy.mockRestore();
  });

  it('carrera real por HTTP: de cada par simultáneo pasa uno y el otro es 409', async () => {
    for (let round = 0; round < 4; round++) {
      const { patientId, e1, e2 } = await childWithTwoEntries();
      const statuses = (
        await Promise.all(
          [e1, e2].map((entry) =>
            post(a, anesthesia(patientId, entry), {
              ...LIDO3,
              anestheticId: lidoA,
            }),
          ),
        )
      )
        .map((res) => res.status)
        .sort();
      expect(statuses).toEqual([201, 409]);
      const rows = await raw.anesthesiaAdministration.findMany({
        where: { patientId },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].overrideReason).toBeNull();
    }
  });

  it('con motivo el segundo pasa y sella el acumulado de las dos evoluciones', async () => {
    const { patientId, e1, e2 } = await childWithTwoEntries();
    await post(a, anesthesia(patientId, e1), {
      ...LIDO3,
      anestheticId: lidoA,
    }).expect(201);
    const res = await post(a, anesthesia(patientId, e2), {
      ...LIDO3,
      anestheticId: lidoA,
      overrideReason: 'Segunda intervención urgente, valorada',
    }).expect(201);
    expect(res.body).toEqual(
      expect.objectContaining({ cumulativeMg: 216, cumulativePercent: 154 }),
    );
  });

  it('RLS: con el tenant de B, la ventana del paciente de A está vacía y el bloqueo no lo encuentra', async () => {
    const { patientId, e1 } = await childWithTwoEntries();
    await post(a, anesthesia(patientId, e1), {
      ...LIDO3,
      anestheticId: lidoA,
    }).expect(201);
    const window = doseWindowAround(new Date());

    const seenByA = await tenantContext.run(a.tenantId, () =>
      repo.listPatientWindow(patientId, window),
    );
    expect(seenByA.map((r) => r.doseMg)).toEqual([108]);
    expect(seenByA[0].authorName).toBe('Dr. Owner');
    const seenByB = await tenantContext.run(b.tenantId, () =>
      repo.listPatientWindow(patientId, window),
    );
    expect(seenByB).toEqual([]);

    const locked = await appRole.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${b.tenantId}, true)`;
      return tx.$queryRaw<{ id: string }[]>`
        SELECT "id" FROM "patients"
        WHERE "id" = ${patientId}::uuid AND "tenantId" = ${b.tenantId}::uuid
        FOR NO KEY UPDATE`;
    });
    expect(locked).toEqual([]);
  });

  it('una administración de otra clínica no puede colgar del paciente (FK compuesta) ni contarle', async () => {
    const { patientId } = await childWithTwoEntries();
    const other = await childWithTwoEntries(b);
    await post(b, anesthesia(other.patientId, other.e1), {
      ...LIDO3,
      anestheticId: lidoB,
    }).expect(201);
    const row = await raw.anesthesiaAdministration.findFirstOrThrow({
      where: { patientId: other.patientId },
    });
    const { id: _id, createdAt: _createdAt, ...copy } = row;
    await expect(
      raw.anesthesiaAdministration.create({
        data: {
          ...copy,
          patientId,
          safetyAlerts: copy.safetyAlerts as Prisma.InputJsonValue,
        },
      }),
    ).rejects.toThrow();
    const seen = await tenantContext.run(a.tenantId, () =>
      repo.listPatientWindow(patientId, doseWindowAround(new Date())),
    );
    expect(seen).toEqual([]);
  });

  it('la consulta de la ventana tiene su índice (tenant, paciente, hora)', async () => {
    const rows = await raw.$queryRaw<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE tablename = 'anesthesia_administrations'
        AND indexname = 'anesthesia_administrations_patient_time_idx'`;
    expect(rows).toHaveLength(1);
    expect(rows[0].indexdef).toContain(
      '("tenantId", "patientId", "administeredAt")',
    );
  });
});
