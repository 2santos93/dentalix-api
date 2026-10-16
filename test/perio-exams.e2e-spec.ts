import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, DocType, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { applyBodyLimits } from '../src/config/body-limits';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';

// DIRECT_URL (owner, sin RLS) solo para sembrar miembros y limpiar. Fuera de
// un contexto de tenant los triggers de inmutabilidad dejan borrar.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';

interface Session {
  tenantId: string;
  accessToken: string;
  subdomain: string;
}

interface SiteBody {
  toothFdi: number;
  site: string;
  probingMm: number | null;
  recessionMm: number | null;
  calMm: number | null;
  bleeding: boolean;
  plaque: boolean;
}

interface ExamBody {
  id: string;
  status: 'DRAFT' | 'FINAL';
  examDate: string;
  providerId: string;
  providerName: string;
  notes: string | null;
  finalizedAt: string | null;
  sites: SiteBody[];
  teeth: { toothFdi: number; mobility: number | null; skipped: boolean }[];
  indices: {
    sitesExamined: number;
    bopPercent: number;
    plaquePercent: number;
    sites4mmOrMore: number;
    sites6mmOrMore: number;
  };
}

async function cleanup(): Promise<void> {
  await raw.perioExam.deleteMany();
  await raw.patient.deleteMany();
  await raw.location.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenantDomain.deleteMany();
  await raw.tenant.deleteMany();
}

describe('Periodontograma — /patients/:id/perio-exams (e2e)', () => {
  let app: INestApplication<App>;
  let clinicA: Session;
  let clinicB: Session;
  let dentistA: { token: string; userId: string };
  let assistantA: string;
  let receptionA: string;
  let patientA: string;
  let otherPatientA: string;
  let patientB: string;
  let examId: string;

  const server = () => app.getHttpServer();

  function as(session: Session, token = session.accessToken) {
    const withAuth = (req: request.Test) =>
      req
        .set('X-Tenant-Host', hostFor(session.subdomain))
        .set('Authorization', `Bearer ${token}`);
    return {
      get: (path: string) => withAuth(request(server()).get(`/api/v1${path}`)),
      post: (path: string, body: object = {}) =>
        withAuth(request(server()).post(`/api/v1${path}`)).send(body),
      put: (path: string, body: object) =>
        withAuth(request(server()).put(`/api/v1${path}`)).send(body),
      delete: (path: string) =>
        withAuth(request(server()).delete(`/api/v1${path}`)),
    };
  }

  async function login(subdomain: string, email: string): Promise<string> {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(subdomain))
      .send({ email, password: PASSWORD })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function register(subdomain: string): Promise<Session> {
    const email = `owner@${subdomain}.com`;
    const reg = await registerVerified(app, {
      clinicName: `Clinica ${subdomain}`,
      subdomain,
      email,
      password: PASSWORD,
      fullName: 'Dr. Owner',
    });
    return {
      tenantId: (reg.body as { tenantId: string }).tenantId,
      accessToken: await login(subdomain, email),
      subdomain,
    };
  }

  async function member(
    session: Session,
    role: ClinicRole,
    fullName: string,
  ): Promise<{ token: string; userId: string }> {
    const email = `${role.toLowerCase()}@${session.subdomain}.com`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwordService.hash(PASSWORD),
        fullName,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId: session.tenantId, userId: user.id, role },
    });
    return { token: await login(session.subdomain, email), userId: user.id };
  }

  async function createPatient(
    session: Session,
    firstName: string,
    docNumber: string,
  ): Promise<string> {
    const res = await as(session)
      .post('/patients', {
        firstName,
        lastName: 'Perio',
        docType: DocType.CC,
        docNumber,
        sex: Sex.F,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const path = (patientId: string, suffix = '') =>
    `/patients/${patientId}/perio-exams${suffix}`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    applyBodyLimits(app);
    await app.init();
    await cleanup();

    clinicA = await register('perio-a');
    clinicB = await register('perio-b');
    dentistA = await member(clinicA, ClinicRole.DENTIST, 'Dra. Perio');
    assistantA = (await member(clinicA, ClinicRole.ASSISTANT, 'Higienista'))
      .token;
    receptionA = (await member(clinicA, ClinicRole.RECEPTION, 'Recepción'))
      .token;
    patientA = await createPatient(clinicA, 'Ana', 'PERIO-A-1');
    otherPatientA = await createPatient(clinicA, 'Bea', 'PERIO-A-2');
    patientB = await createPatient(clinicB, 'Carla', 'PERIO-B-1');
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('el dentista crea un DRAFT; el autor sale del token', async () => {
    const res = await as(clinicA, dentistA.token)
      .post(path(patientA), { examDate: '2026-04-10', notes: 'Inicial' })
      .expect(201);
    const exam = res.body as ExamBody;
    expect(exam).toMatchObject({
      status: 'DRAFT',
      examDate: '2026-04-10',
      providerId: dentistA.userId,
      providerName: 'Dra. Perio',
      notes: 'Inicial',
      sites: [],
      teeth: [],
    });
    examId = exam.id;
  });

  it('guarda medidas (upsert) y el detalle devuelve NIC = sondaje + recesión', async () => {
    const res = await as(clinicA, dentistA.token)
      .put(path(patientA, `/${examId}/measures`), {
        sites: [
          {
            toothFdi: 16,
            site: 'MB',
            probingMm: 5,
            recessionMm: 2,
            bleeding: true,
          },
          { toothFdi: 16, site: 'B', probingMm: 3, plaque: true },
          { toothFdi: 16, site: 'DB', probingMm: 6, recessionMm: -1 },
          { toothFdi: 18, site: 'MB', probingMm: 9, bleeding: true },
        ],
        teeth: [
          { toothFdi: 16, mobility: 1 },
          { toothFdi: 18, skipped: true },
        ],
      })
      .expect(200);
    const exam = res.body as ExamBody;
    expect(exam.sites).toHaveLength(4);
    expect(
      exam.sites.find((s) => s.site === 'MB' && s.toothFdi === 16),
    ).toMatchObject({ probingMm: 5, recessionMm: 2, calMm: 7, bleeding: true });
    expect(exam.sites.find((s) => s.site === 'DB')?.calMm).toBe(5);
    // 18 omitido: fuera de los índices.
    expect(exam.indices).toEqual({
      sitesExamined: 3,
      bopPercent: 33.3,
      plaquePercent: 33.3,
      sites4mmOrMore: 2,
      sites6mmOrMore: 1,
    });

    // El asistente (higienista) también escribe; un sitio vacío borra.
    const again = await as(clinicA, assistantA)
      .put(path(patientA, `/${examId}/measures`), {
        sites: [{ toothFdi: 16, site: 'B' }],
        teeth: [],
        notes: 'Revisado',
      })
      .expect(200);
    expect((again.body as ExamBody).sites).toHaveLength(3);
    expect((again.body as ExamBody).notes).toBe('Revisado');

    // Al recargar sigue ahí.
    const reloaded = await as(clinicA)
      .get(path(patientA, `/${examId}`))
      .expect(200);
    expect((reloaded.body as ExamBody).sites).toHaveLength(3);
  });

  it('valida rangos, FDI y sitio con 400 en español', async () => {
    const cases: [object, string][] = [
      [
        { toothFdi: 19, site: 'MB' },
        'Diente 19 no es un diente permanente válido (FDI 11–48)',
      ],
      [
        { toothFdi: 55, site: 'MB' },
        'Diente 55 no es un diente permanente válido (FDI 11–48)',
      ],
      [
        { toothFdi: 16, site: 'XX' },
        'Diente 16: sitio «XX» no válido (MB, B, DB, ML, L, DL)',
      ],
      [
        { toothFdi: 16, site: 'MB', probingMm: 20 },
        'el sondaje debe ser un entero entre 0 y 19 mm',
      ],
      [
        { toothFdi: 16, site: 'MB', recessionMm: -6 },
        'la recesión debe ser un entero entre -5 y 19 mm',
      ],
      [
        { toothFdi: 16, site: 'MB', furcation: 4 },
        'la furca debe ser 0, 1, 2 o 3',
      ],
    ];
    for (const [site, message] of cases) {
      const res = await as(clinicA)
        .put(path(patientA, `/${examId}/measures`), {
          sites: [site],
          teeth: [],
        })
        .expect(400);
      expect((res.body as { message: string }).message).toContain(message);
    }
    const mobility = await as(clinicA)
      .put(path(patientA, `/${examId}/measures`), {
        sites: [],
        teeth: [{ toothFdi: 16, mobility: 4 }],
      })
      .expect(400);
    expect((mobility.body as { message: string }).message).toBe(
      'Diente 16: la movilidad debe ser 0, 1, 2 o 3',
    );
    await as(clinicA)
      .post(path(patientA), { examDate: '2999-01-01' })
      .expect(400);
    const impossible = await as(clinicA)
      .post(path(patientA), { examDate: '2026-02-31' })
      .expect(400);
    expect((impossible.body as { message: string }).message).toBe(
      'La fecha del examen no existe en el calendario',
    );
  });

  it('lista el histórico por fecha desc con índices', async () => {
    const second = await as(clinicA)
      .post(path(patientA), { copySkippedFromLast: true })
      .expect(201);
    const secondExam = second.body as ExamBody;
    // El 18 venía omitido en el examen anterior.
    expect(secondExam.teeth).toEqual([
      { toothFdi: 18, mobility: null, skipped: true },
    ]);
    const res = await as(clinicA).get(path(patientA)).expect(200);
    const rows = res.body as ExamBody[];
    expect(rows.map((r) => r.id)).toEqual([secondExam.id, examId]);
    expect(rows[1].indices.sites6mmOrMore).toBe(1);
    expect(rows[1]).not.toHaveProperty('sites');
    // El borrador recién creado se puede borrar.
    await as(clinicA)
      .delete(path(patientA, `/${secondExam.id}`))
      .expect(204);
  });

  it('finalizar deja el examen inmutable: 409 a cambios, a re-finalizar y a borrar', async () => {
    const res = await as(clinicA, dentistA.token)
      .post(path(patientA, `/${examId}/finalize`))
      .expect(200);
    expect((res.body as ExamBody).status).toBe('FINAL');
    expect((res.body as ExamBody).finalizedAt).not.toBeNull();

    const put = await as(clinicA)
      .put(path(patientA, `/${examId}/measures`), {
        sites: [{ toothFdi: 11, site: 'B', probingMm: 2 }],
        teeth: [],
      })
      .expect(409);
    expect((put.body as { message: string }).message).toMatch(/finalizado/);
    await as(clinicA)
      .post(path(patientA, `/${examId}/finalize`))
      .expect(409);
    await as(clinicA)
      .delete(path(patientA, `/${examId}`))
      .expect(409);
  });

  it('RECEPTION recibe 403 en todas las rutas', async () => {
    await as(clinicA, receptionA).get(path(patientA)).expect(403);
    await as(clinicA, receptionA).post(path(patientA)).expect(403);
    await as(clinicA, receptionA)
      .get(path(patientA, `/${examId}`))
      .expect(403);
    await as(clinicA, receptionA)
      .put(path(patientA, `/${examId}/measures`), { sites: [], teeth: [] })
      .expect(403);
    await as(clinicA, receptionA)
      .post(path(patientA, `/${examId}/finalize`))
      .expect(403);
  });

  it('aislamiento: la clínica B no lee ni escribe exámenes de pacientes de A', async () => {
    await as(clinicB).get(path(patientA)).expect(404);
    await as(clinicB).post(path(patientA)).expect(404);
    await as(clinicB)
      .get(path(patientA, `/${examId}`))
      .expect(404);
    await as(clinicB)
      .put(path(patientA, `/${examId}/measures`), { sites: [], teeth: [] })
      .expect(404);
    await as(clinicB)
      .post(path(patientA, `/${examId}/finalize`))
      .expect(404);
    await as(clinicB)
      .delete(path(patientA, `/${examId}`))
      .expect(404);
    // Ni colgándolo de un paciente propio de B.
    await as(clinicB)
      .get(path(patientB, `/${examId}`))
      .expect(404);
    // Ni desde otro paciente de la MISMA clínica.
    await as(clinicA)
      .get(path(otherPatientA, `/${examId}`))
      .expect(404);
    // Y B no ve nada en su lista.
    const listB = await as(clinicB).get(path(patientB)).expect(200);
    expect(listB.body).toEqual([]);
    expect(
      await raw.perioExam.count({ where: { tenantId: clinicB.tenantId } }),
    ).toBe(0);
  });
});
