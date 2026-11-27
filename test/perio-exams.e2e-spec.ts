import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { applyBodyLimits } from '../src/config/body-limits';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_CARACAS_FIXTURE,
  registerBody,
} from './support/location-fixtures';
import { createAppValidationPipe } from '../src/shared/validation/app-validation-pipe';

// DIRECT_URL (owner, sin RLS) solo para sembrar miembros y limpiar. Fuera de
// un contexto de tenant los triggers de inmutabilidad dejan borrar.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
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
  furcation: number | null;
  bleeding: boolean;
  plaque: boolean;
  calculus: boolean;
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
    sitesAlertOrMore: number;
    sitesSevereOrMore: number;
  };
  thresholds: { pdAlertMm: number; pdSevereMm: number };
}

async function cleanup(): Promise<void> {
  await resetDatabase(raw);
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
      patch: (path: string, body: object) =>
        withAuth(request(server()).patch(`/api/v1${path}`)).send(body),
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
    const reg = await registerVerified(
      app,
      registerBody(REGIONAL_CARACAS_FIXTURE, {
        clinicName: `Clinica ${subdomain}`,
        subdomain,
        email,
        password: PASSWORD,
        fullName: 'Dr. Owner',
      }),
    );
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
        docType: 'NATIONAL_ID',
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
    app.useGlobalPipes(createAppValidationPipe());
    applyBodyLimits(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
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

  // DX-251: los tests de permisos y aislamiento crean su propio examen (en
  // DRAFT, el estado escribible) para pasar también ejecutados solos (-t).
  async function draftExamOfA(): Promise<string> {
    const res = await as(clinicA, dentistA.token)
      .post(path(patientA), { examDate: '2026-04-12', notes: 'Propio' })
      .expect(201);
    return (res.body as ExamBody).id;
  }

  /**
   * DX-066: `n` exámenes FINAL del paciente, un mes entre uno y otro, con el
   * sondaje del 16 MB subiendo 1 mm por examen y el NIC 2 mm (recesión +1).
   */
  async function finalExamsOf(
    session: Session,
    patientId: string,
    n: number,
    token = session.accessToken,
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i += 1) {
      const created = await as(session, token)
        .post(path(patientId), { examDate: `2026-0${i + 1}-20` })
        .expect(201);
      const id = (created.body as ExamBody).id;
      await as(session, token)
        .put(path(patientId, `/${id}/measures`), {
          sites: [
            {
              toothFdi: 16,
              site: 'MB',
              probingMm: 3 + i,
              recessionMm: i,
              bleeding: i % 2 === 0,
            },
            { toothFdi: 21, site: 'B', probingMm: 5 - i },
          ],
          teeth: [],
        })
        .expect(200);
      await as(session, token)
        .post(path(patientId, `/${id}/finalize`))
        .expect(200);
      ids.push(id);
    }
    return ids;
  }

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
      sitesAlertOrMore: 2,
      sitesSevereOrMore: 1,
    });
    expect(exam.thresholds).toEqual({ pdAlertMm: 4, pdSevereMm: 6 });

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

  // DX-103: el guardado va en un lote y la lista sale de un resumen en la base.
  it('un periodontograma completo se guarda de una vez y la lista da sus índices sin medidas', async () => {
    const created = await as(clinicA, dentistA.token)
      .post(path(otherPatientA), { examDate: '2026-04-11' })
      .expect(201);
    const id = (created.body as ExamBody).id;
    const teeth = [1, 2, 3, 4].flatMap((q) =>
      [1, 2, 3, 4, 5, 6, 7, 8].map((d) => q * 10 + d),
    );
    const sites = teeth.flatMap((toothFdi, t) =>
      (['MB', 'B', 'DB', 'ML', 'L', 'DL'] as const).map((site, i) => ({
        toothFdi,
        site,
        probingMm: (t + i) % 9,
        recessionMm: ((t * i) % 7) - 2,
        bleeding: (t + i) % 3 === 0,
        plaque: (t + i) % 4 === 0,
        // DX-066: furca solo donde tiene sentido (vestibular de molares).
        furcation: site === 'B' && toothFdi % 10 >= 6 ? t % 4 : null,
      })),
    );
    const saved = await as(clinicA, assistantA)
      .put(path(otherPatientA, `/${id}/measures`), {
        sites,
        teeth: teeth.map((toothFdi, t) => ({
          toothFdi,
          mobility: t % 5 === 0 ? 1 : null,
          skipped: t % 11 === 0,
        })),
      })
      .expect(200);
    const detail = saved.body as ExamBody;
    expect(detail.sites).toHaveLength(192);
    expect(detail.indices.sitesExamined).toBeGreaterThan(150);

    // El ayudante también lee la lista; la fila trae los mismos índices que
    // el detalle y ninguna medida.
    const list = await as(clinicA, assistantA)
      .get(path(otherPatientA))
      .expect(200);
    const rows = list.body as Record<string, unknown>[];
    const row = rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row?.indices).toEqual(detail.indices);
    for (const r of rows) {
      expect(r).not.toHaveProperty('sites');
      expect(r).not.toHaveProperty('teeth');
    }
    // La lista de patientA no lo incluye (acotada por paciente).
    const listA = await as(clinicA).get(path(patientA)).expect(200);
    expect((listA.body as ExamBody[]).map((r) => r.id)).not.toContain(id);
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
    const examId = await draftExamOfA();
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

  // ISOLATION_COVERS: GET /patients/:patientId/perio-exams
  // ISOLATION_COVERS: POST /patients/:patientId/perio-exams
  // ISOLATION_COVERS: GET /patients/:patientId/perio-exams/:id
  // ISOLATION_COVERS: PUT /patients/:patientId/perio-exams/:id/measures
  // ISOLATION_COVERS: POST /patients/:patientId/perio-exams/:id/finalize
  // ISOLATION_COVERS: DELETE /patients/:patientId/perio-exams/:id
  // ISOLATION_COVERS: PATCH /patients/:patientId/perio-exams/:id
  // ISOLATION_COVERS: GET /patients/:patientId/perio-exams/compare
  it('aislamiento: la clínica B no lee ni escribe exámenes de pacientes de A', async () => {
    const examId = await draftExamOfA();
    // DX-066: ni cambia las notas ni compara (ni desde su paciente).
    const finalIds = await finalExamsOf(clinicA, patientA, 2);
    await as(clinicB)
      .patch(path(patientA, `/${examId}`), { notes: 'Intruso' })
      .expect(404);
    await as(clinicB)
      .get(path(patientA, `/compare?examIds=${finalIds.join(',')}`))
      .expect(404);
    await as(clinicB)
      .get(path(patientB, `/compare?examIds=${finalIds.join(',')}`))
      .expect(404);
    expect(
      (await raw.perioExam.findUniqueOrThrow({ where: { id: examId } })).notes,
    ).toBe('Propio');
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

  describe('DX-066: deudas de DX-007', () => {
    let patientC: string;

    beforeAll(async () => {
      patientC = await createPatient(clinicA, 'Diana', 'PERIO-A-3');
    });

    it('PATCH de notas: cambia y borra las de un DRAFT; un FINAL da 409 en español', async () => {
      const created = await as(clinicA, dentistA.token)
        .post(path(patientC), { examDate: '2026-05-02', notes: 'Primera' })
        .expect(201);
      const id = (created.body as ExamBody).id;
      const patched = await as(clinicA, assistantA)
        .patch(path(patientC, `/${id}`), {
          notes: '  Control en 3 meses tras raspado  ',
        })
        .expect(200);
      expect((patched.body as ExamBody).notes).toBe(
        'Control en 3 meses tras raspado',
      );
      const cleared = await as(clinicA, dentistA.token)
        .patch(path(patientC, `/${id}`), { notes: null })
        .expect(200);
      expect((cleared.body as ExamBody).notes).toBeNull();
      const missing = await as(clinicA)
        .patch(path(patientC, `/${id}`), {})
        .expect(400);
      expect(JSON.stringify(missing.body)).toContain(
        'Faltan las notas (null para borrarlas)',
      );
      const tooLong = await as(clinicA)
        .patch(path(patientC, `/${id}`), { notes: 'x'.repeat(2001) })
        .expect(400);
      expect(JSON.stringify(tooLong.body)).toContain(
        'Las notas no pueden superar 2000 caracteres',
      );
      await as(clinicA, receptionA)
        .patch(path(patientC, `/${id}`), { notes: 'Recepción' })
        .expect(403);

      await as(clinicA)
        .patch(path(patientC, `/${id}`), { notes: 'Antes de cerrar' })
        .expect(200);
      await as(clinicA)
        .post(path(patientC, `/${id}/finalize`))
        .expect(200);
      const locked = await as(clinicA, dentistA.token)
        .patch(path(patientC, `/${id}`), { notes: 'Después de cerrar' })
        .expect(409);
      expect((locked.body as { message: string }).message).toBe(
        'El examen está finalizado: no se puede modificar ni borrar. Para corregirlo crea un examen nuevo.',
      );
      expect(
        (await raw.perioExam.findUniqueOrThrow({ where: { id } })).notes,
      ).toBe('Antes de cerrar');
      // Otro paciente de la misma clínica: 404.
      await as(clinicA)
        .patch(path(patientA, `/${id}`), { notes: 'x' })
        .expect(404);
      const events = await raw.auditEvent.findMany({
        where: {
          tenantId: clinicA.tenantId,
          resourceType: 'PERIO_EXAM',
          resourceId: id,
          action: 'UPDATE',
        },
      });
      expect(
        events.filter(
          (e) => (e.metadata as { reason?: string }).reason === 'PERIO_NOTES',
        ).length,
      ).toBeGreaterThanOrEqual(3);
    });

    it('furca MP/DP en molares superiores y CALC se capturan y persisten; donde no tiene sentido, 400', async () => {
      const created = await as(clinicA, dentistA.token)
        .post(path(patientC), { examDate: '2026-05-03' })
        .expect(201);
      const id = (created.body as ExamBody).id;
      await as(clinicA, assistantA)
        .put(path(patientC, `/${id}/measures`), {
          sites: [
            { toothFdi: 26, site: 'B', probingMm: 4, furcation: 3 },
            { toothFdi: 26, site: 'ML', probingMm: 5, furcation: 2 },
            { toothFdi: 26, site: 'DL', probingMm: 6, furcation: 1 },
            { toothFdi: 17, site: 'ML', furcation: 0 },
            { toothFdi: 46, site: 'L', probingMm: 3, furcation: 1 },
            { toothFdi: 31, site: 'L', probingMm: 2, calculus: true },
            { toothFdi: 41, site: 'B', calculus: true, plaque: true },
          ],
          teeth: [],
        })
        .expect(200);
      const reloaded = await as(clinicA)
        .get(path(patientC, `/${id}`))
        .expect(200);
      const sites = (reloaded.body as ExamBody).sites;
      const at = (fdi: number, s: string) =>
        sites.find((x) => x.toothFdi === fdi && x.site === s);
      expect(at(26, 'B')?.furcation).toBe(3);
      expect(at(26, 'ML')?.furcation).toBe(2);
      expect(at(26, 'DL')?.furcation).toBe(1);
      expect(at(17, 'ML')?.furcation).toBe(0);
      expect(at(46, 'L')?.furcation).toBe(1);
      expect(at(31, 'L')).toMatchObject({ calculus: true, probingMm: 2 });
      expect(at(41, 'B')).toMatchObject({ calculus: true, plaque: true });
      // En la base: CALC es el bit 8 del bitmask.
      const row = await raw.perioSiteMeasure.findFirstOrThrow({
        where: { examId: id, toothFdi: 41, site: 'B' },
      });
      expect(row.flags & 8).toBe(8);

      const cases: [object, string][] = [
        [
          { toothFdi: 11, site: 'B', furcation: 1 },
          'Diente 11, sitio B: la furca solo se registra en molares: superiores en B, MP (sitio ML) y DP (sitio DL); inferiores en B y L',
        ],
        [{ toothFdi: 16, site: 'L', furcation: 1 }, 'Diente 16, sitio L:'],
        [{ toothFdi: 36, site: 'ML', furcation: 2 }, 'Diente 36, sitio ML:'],
        [{ toothFdi: 14, site: 'MB', furcation: 1 }, 'Diente 14, sitio MB:'],
      ];
      for (const [site, message] of cases) {
        const res = await as(clinicA)
          .put(path(patientC, `/${id}/measures`), { sites: [site], teeth: [] })
          .expect(400);
        expect((res.body as { message: string }).message).toContain(message);
      }
      // Limpiar la furca (null) vale en cualquier sitio.
      await as(clinicA)
        .put(path(patientC, `/${id}/measures`), {
          sites: [{ toothFdi: 26, site: 'ML', probingMm: 5, furcation: null }],
          teeth: [],
        })
        .expect(200);
    });

    it('compara 2–4 exámenes FINAL con Δ por sitio, en orden cronológico', async () => {
      const patientD = await createPatient(clinicA, 'Elena', 'PERIO-A-4');
      const ids = await finalExamsOf(clinicA, patientD, 4, dentistA.token);
      type Comparison = {
        thresholds: { pdAlertMm: number; pdSevereMm: number };
        worseningMm: number;
        exams: { id: string; examDate: string; indices: ExamBody['indices'] }[];
        sites: {
          toothFdi: number;
          site: string;
          values: {
            probingMm: number | null;
            calMm: number | null;
            deltaProbingMm: number | null;
            deltaCalMm: number | null;
          }[];
          deltaProbingMm: number | null;
          deltaCalMm: number | null;
          worsened: boolean;
          improved: boolean;
        }[];
      };
      // Desordenados y separados por comas.
      const four = await as(clinicA, assistantA)
        .get(
          path(
            patientD,
            `/compare?examIds=${[ids[2], ids[0], ids[3], ids[1]].join(',')}`,
          ),
        )
        .expect(200);
      const body = four.body as Comparison;
      expect(body.exams.map((e) => e.id)).toEqual(ids);
      expect(body.exams.map((e) => e.examDate)).toEqual([
        '2026-01-20',
        '2026-02-20',
        '2026-03-20',
        '2026-04-20',
      ]);
      expect(body.thresholds).toEqual({ pdAlertMm: 4, pdSevereMm: 6 });
      expect(body.worseningMm).toBe(2);
      expect(body.sites.map((s) => `${s.toothFdi}${s.site}`)).toEqual([
        '16MB',
        '21B',
      ]);
      const [mb, b21] = body.sites;
      expect(mb.values.map((v) => v.probingMm)).toEqual([3, 4, 5, 6]);
      expect(mb.values.map((v) => v.calMm)).toEqual([3, 5, 7, 9]);
      expect(mb.values.map((v) => v.deltaProbingMm)).toEqual([null, 1, 1, 1]);
      expect(mb.values.map((v) => v.deltaCalMm)).toEqual([null, 2, 2, 2]);
      expect(mb).toMatchObject({
        deltaProbingMm: 3,
        deltaCalMm: 6,
        worsened: true,
        improved: false,
      });
      expect(b21).toMatchObject({ deltaProbingMm: -3, improved: true });
      // Evolución: BOP% y sitios ≥ alerta / ≥ severo por examen.
      expect(body.exams.map((e) => e.indices.bopPercent)).toEqual([
        50, 0, 50, 0,
      ]);
      expect(body.exams.map((e) => e.indices.sitesAlertOrMore)).toEqual([
        1, 2, 1, 1,
      ]);
      expect(body.exams.map((e) => e.indices.sitesSevereOrMore)).toEqual([
        0, 0, 0, 1,
      ]);

      // Dos, con el parámetro repetido: Δ de 1 mm no es empeoramiento.
      const two = await as(clinicA, dentistA.token)
        .get(path(patientD, `/compare?examIds=${ids[0]}&examIds=${ids[1]}`))
        .expect(200);
      expect((two.body as Comparison).sites[0]).toMatchObject({
        deltaProbingMm: 1,
        deltaCalMm: 2,
        worsened: true,
      });
      expect((two.body as Comparison).sites[1]).toMatchObject({
        deltaProbingMm: -1,
        worsened: false,
        improved: false,
      });
      const three = await as(clinicA)
        .get(path(patientD, `/compare?examIds=${ids.slice(0, 3).join(',')}`))
        .expect(200);
      expect((three.body as Comparison).exams).toHaveLength(3);

      const draft = await as(clinicA)
        .post(path(patientD), { examDate: '2026-05-20' })
        .expect(201);
      const draftId = (draft.body as ExamBody).id;
      const other = await finalExamsOf(clinicA, patientC, 1);
      const bad: [string, number, string][] = [
        [ids[0], 400, 'Elige entre 2 y 4 exámenes para comparar'],
        [
          [...ids, other[0]].join(','),
          400,
          'Elige entre 2 y 4 exámenes para comparar',
        ],
        [
          `${ids[0]},no-es-uuid`,
          400,
          'Cada examen a comparar debe ser un identificador válido',
        ],
        [
          `${ids[0]},${ids[0]}`,
          400,
          'Un examen está repetido en la comparación',
        ],
        [
          `${ids[0]},${draftId}`,
          400,
          'Solo se comparan exámenes finalizados: finaliza el borrador o quítalo de la comparación',
        ],
        // Examen de otro paciente de la misma clínica.
        [`${ids[0]},${other[0]}`, 404, 'Examen periodontal no encontrado'],
      ];
      for (const [query, status, message] of bad) {
        const res = await as(clinicA)
          .get(path(patientD, `/compare?examIds=${query}`))
          .expect(status);
        expect(JSON.stringify(res.body)).toContain(message);
      }
      await as(clinicA).get(path(patientD, '/compare')).expect(400);
      await as(clinicA, receptionA)
        .get(path(patientD, `/compare?examIds=${ids.slice(0, 2).join(',')}`))
        .expect(403);
      const audited = await raw.auditEvent.findMany({
        where: {
          tenantId: clinicA.tenantId,
          resourceType: 'PERIO_EXAM',
          action: 'VIEW',
        },
      });
      expect(
        audited.some(
          (e) =>
            (e.metadata as { reason?: string }).reason === 'PERIO_COMPARISON',
        ),
      ).toBe(true);
    });

    it('umbrales: los leen los clínicos, los cambia solo ADMIN (auditado) y colorean índices y comparación', async () => {
      const settings = '/perio/settings';
      const read = await as(clinicA, dentistA.token).get(settings).expect(200);
      expect(read.body).toEqual({ pdAlertMm: 4, pdSevereMm: 6 });
      await as(clinicA, assistantA).get(settings).expect(200);
      await as(clinicA, receptionA).get(settings).expect(403);
      const denied = await as(clinicA, dentistA.token)
        .put(settings, { pdAlertMm: 5 })
        .expect(403);
      expect((denied.body as { message: string }).message).toBe(
        'Solo un administrador puede cambiar los umbrales del periodontograma.',
      );
      await as(clinicA, assistantA).put(settings, { pdAlertMm: 5 }).expect(403);

      const badCases: [object, string][] = [
        [
          { pdAlertMm: 6, pdSevereMm: 6 },
          'El umbral de alerta debe ser menor que el severo',
        ],
        [{ pdAlertMm: 7 }, 'El umbral de alerta debe ser menor que el severo'],
        [
          { pdAlertMm: 1 },
          'El umbral de alerta debe ser un entero entre 2 y 10 mm',
        ],
        [
          { pdSevereMm: 13 },
          'El umbral severo debe ser un entero entre 3 y 12 mm',
        ],
        [
          { pdAlertMm: 4.5 },
          'El umbral de alerta debe ser un entero entre 2 y 10 mm',
        ],
        [
          { pdSevereMm: '7' },
          'El umbral severo debe ser un entero entre 3 y 12 mm',
        ],
      ];
      for (const [body, message] of badCases) {
        const res = await as(clinicA).put(settings, body).expect(400);
        expect(JSON.stringify(res.body)).toContain(message);
      }

      const events = async () =>
        (
          await raw.auditEvent.findMany({
            where: {
              tenantId: clinicA.tenantId,
              resourceType: 'CLINIC_SETTINGS',
            },
            orderBy: { occurredAt: 'desc' },
          })
        ).filter(
          (e) =>
            (e.metadata as { reason?: string }).reason === 'PERIO_SETTINGS',
        );
      expect(await events()).toHaveLength(0);
      const updated = await as(clinicA)
        .put(settings, { pdAlertMm: 5, pdSevereMm: 7 })
        .expect(200);
      expect(updated.body).toEqual({ pdAlertMm: 5, pdSevereMm: 7 });
      const [event] = await events();
      expect(event.metadata).toEqual({
        reason: 'PERIO_SETTINGS',
        changedFields: ['pdAlertMm', 'pdSevereMm'],
        statusChange: { from: 'PD_A4_S6', to: 'PD_A5_S7' },
      });
      // Sin cambio: 200 y ningún evento más.
      await as(clinicA).put(settings, { pdAlertMm: 5 }).expect(200);
      expect(await events()).toHaveLength(1);

      // El detalle, la lista y la comparación cuentan con 5 / 7.
      const patientE = await createPatient(clinicA, 'Fabiola', 'PERIO-A-5');
      const ids = await finalExamsOf(clinicA, patientE, 4);
      const detail = await as(clinicA)
        .get(path(patientE, `/${ids[3]}`))
        .expect(200);
      expect((detail.body as ExamBody).thresholds).toEqual({
        pdAlertMm: 5,
        pdSevereMm: 7,
      });
      // 16 MB = 6 y 21 B = 2: uno ≥ 5, ninguno ≥ 7; ≥4/≥6 no cambian.
      expect((detail.body as ExamBody).indices).toMatchObject({
        sitesAlertOrMore: 1,
        sitesSevereOrMore: 0,
        sites4mmOrMore: 1,
        sites6mmOrMore: 1,
      });
      const list = await as(clinicA).get(path(patientE)).expect(200);
      expect(
        (list.body as ExamBody[]).find((r) => r.id === ids[3])?.indices,
      ).toEqual((detail.body as ExamBody).indices);
      const comparison = await as(clinicA)
        .get(path(patientE, `/compare?examIds=${ids.join(',')}`))
        .expect(200);
      const cmp = comparison.body as {
        thresholds: object;
        exams: { indices: ExamBody['indices'] }[];
      };
      expect(cmp.thresholds).toEqual({ pdAlertMm: 5, pdSevereMm: 7 });
      // ≥ 5: (3, 5), (4, 4), (5, 3), (6, 2).
      expect(cmp.exams.map((e) => e.indices.sitesAlertOrMore)).toEqual([
        1, 0, 1, 1,
      ]);

      // La otra clínica conserva los de fábrica.
      const other = await as(clinicB).get(settings).expect(200);
      expect(other.body).toEqual({ pdAlertMm: 4, pdSevereMm: 6 });

      // Se dejan como estaban para el resto del fichero.
      await as(clinicA)
        .put(settings, { pdAlertMm: 4, pdSevereMm: 6 })
        .expect(200);
    });
  });
});
