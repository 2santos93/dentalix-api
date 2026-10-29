import { INestApplication } from '@nestjs/common';
import { ClinicRole, DocType, Prisma, PrismaClient, Sex } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PAYER_TYPES } from '../src/modules/payers/domain/payer-type';
import { createE2eApp } from './support/create-e2e-app';
import {
  Clinic,
  loginAs,
  registerClinic,
  resetDatabase,
  seedMember,
} from './support/e2e-fixtures';

// SEC-049 en HTTP real: la cobertura que habilita un convenio tiene que ser
// verificable. La auditoría BE-043 vio que ASSISTANT y RECEPTION creaban la
// cobertura con solo `{ payerId }` y en la llamada siguiente se asignaban el
// convenio del 100 %. Ahora:
// - con un pagador externo, el nº de afiliado es obligatorio (400 en español);
//   las coberturas anteriores sin nº (migradas o creadas antes) siguen igual;
// - quien no es ADMIN no asigna con una cobertura cuyo pagador o nº registró
//   él mismo si un ADMIN no la verificó (403 que dice qué falta);
// - verificar es solo de ADMIN, queda auditado y editar el nº lo borra.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const ROLES = [
  ClinicRole.ADMIN,
  ClinicRole.DENTIST,
  ClinicRole.ASSISTANT,
  ClinicRole.RECEPTION,
] as const;
type Role = (typeof ROLES)[number];

const SELF_DECLARED =
  'Registraste tú el pagador o el nº de afiliado de esta cobertura y aún no la ha verificado un administrador: pide a un administrador que la verifique (o que asigne él el convenio).';
// Una regla única para todo pagador externo, sin supuestos de país (DX-311).
const REQUIRED =
  'El nº de afiliado o póliza es obligatorio con un pagador externo.';
const FORMAT =
  'El nº de afiliado o póliza debe tener entre 4 y 40 caracteres: letras, números, espacios, guiones, puntos o barras.';
const NO_DIGIT = 'El nº de afiliado o póliza debe tener al menos un número.';
const VERIFY_ADMIN_ONLY =
  'Solo un administrador puede verificar una cobertura.';
const VERIFY_STALE =
  'El pagador o el nº de afiliado de esta cobertura cambió mientras lo revisabas: vuelve a abrirla y compruébalo.';
const COVERAGE_NOT_FOUND = 'Cobertura no encontrada.';

const NUMBER = '1020304050';

describe('Cobertura verificable para asignar un convenio (e2e, SEC-049)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let other: Clinic;
  const tokens = {} as Record<Role, string>;
  const userIds = {} as Record<Role, string>;
  let payer: string;
  let agreement: string;
  let foreignPatient: string;
  let foreignCoverage: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test, token: string, host = clinic.host) =>
    req.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);
  const coverages = (patientId: string) =>
    `/api/v1/patients/${patientId}/coverages`;
  const verification = (patientId: string, coverageId: string) =>
    `${coverages(patientId)}/${coverageId}/verification`;
  const assignment = (patientId: string) =>
    `/api/v1/patients/${patientId}/agreement`;
  const message = (res: request.Response) =>
    (res.body as { message: string }).message;

  async function post(
    path: string,
    body: Record<string, unknown>,
    token: string,
    host = clinic.host,
  ): Promise<string> {
    const res = await as(api().post(path), token, host).send(body).expect(201);
    return (res.body as { id: string }).id;
  }

  const createPatient = (firstName: string, target: Clinic = clinic) =>
    post(
      '/api/v1/patients',
      {
        docType: DocType.CC,
        sex: Sex.F,
        lastName: 'Verificable',
        docNumber: String(Math.floor(Math.random() * 1e9)),
        firstName,
      },
      target.adminToken,
      target.host,
    );

  const createCoverage = (patientId: string, token: string) =>
    post(coverages(patientId), { payerId: payer, memberNumber: NUMBER }, token);

  const verify = (
    patientId: string,
    coverageId: string,
    token = tokens.ADMIN,
    checkedMemberNumber = NUMBER,
  ) =>
    as(api().post(verification(patientId, coverageId)), token).send({
      checkedMemberNumber,
    });

  const assign = (patientId: string, coverageId: string, token: string) =>
    as(api().put(assignment(patientId)), token).send({
      agreementId: agreement,
      coverageId,
    });

  const coverageEvents = (patientId: string) =>
    raw.auditEvent.findMany({
      where: { tenantId: clinic.tenantId, patientId },
      orderBy: { occurredAt: 'asc' },
      select: { actorRole: true, actorUserId: true, metadata: true },
    });

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(raw);
    clinic = await registerClinic(app, 'sec049-verif');
    other = await registerClinic(app, 'sec049-verif-otra');
    tokens.ADMIN = clinic.adminToken;
    userIds.ADMIN = clinic.adminUserId;
    for (const role of [
      ClinicRole.DENTIST,
      ClinicRole.ASSISTANT,
      ClinicRole.RECEPTION,
    ] as const) {
      const member = await seedMember(raw, clinic, role);
      tokens[role] = await loginAs(app, clinic.host, member.email);
      userIds[role] = member.userId;
    }
    payer = await post(
      '/api/v1/payers',
      { name: 'Aseguradora Norte', type: 'EMPLOYER' },
      tokens.ADMIN,
    );
    agreement = await post(
      '/api/v1/agreements',
      {
        name: 'Aseguradora Norte 100 %',
        payerId: payer,
        kind: 'PERCENT_DISCOUNT',
        percent: 100,
      },
      tokens.ADMIN,
    );

    // La otra clínica: su pagador con el mismo nombre y una cobertura VERIFICADA.
    const foreignPayer = await post(
      '/api/v1/payers',
      { name: 'Aseguradora Norte', type: 'EMPLOYER' },
      other.adminToken,
      other.host,
    );
    foreignPatient = await createPatient('Ajena', other);
    foreignCoverage = await post(
      coverages(foreignPatient),
      { payerId: foreignPayer, memberNumber: '9988776655' },
      other.adminToken,
      other.host,
    );
    await as(
      api().post(verification(foreignPatient, foreignCoverage)),
      other.adminToken,
      other.host,
    )
      .send({ checkedMemberNumber: '9988776655' })
      .expect(200);
  });

  afterAll(async () => {
    await resetDatabase(raw);
    await app.close();
    await raw.$disconnect();
  });

  describe('nº de afiliado obligatorio con un pagador externo', () => {
    it.each(ROLES)(
      '%s: sin nº, con un formato no válido o sin ningún número, 400 en español y nada escrito',
      async (role) => {
        const patient = await createPatient(`Sin número ${role}`);
        const missing = await as(api().post(coverages(patient)), tokens[role])
          .send({ payerId: payer })
          .expect(400);
        expect(message(missing)).toBe(REQUIRED);
        const blank = await as(api().post(coverages(patient)), tokens[role])
          .send({ payerId: payer, memberNumber: '   ' })
          .expect(400);
        expect(message(blank)).toBe(REQUIRED);
        const bad = await as(api().post(coverages(patient)), tokens[role])
          .send({ payerId: payer, memberNumber: 'AF#12' })
          .expect(400);
        expect(message(bad)).toBe(FORMAT);
        const noDigit = await as(api().post(coverages(patient)), tokens[role])
          .send({ payerId: payer, memberNumber: 'POLIZA' })
          .expect(400);
        expect(message(noDigit)).toBe(NO_DIGIT);
        expect(
          await raw.patientCoverage.count({ where: { patientId: patient } }),
        ).toBe(0);
      },
    );

    it('con un pagador interno (OTHER) sigue siendo opcional', async () => {
      const cortesia = await post(
        '/api/v1/payers',
        { name: 'Cortesía', type: 'OTHER' },
        tokens.ADMIN,
      );
      const patient = await createPatient('Cortesía');
      await as(api().post(coverages(patient)), tokens.RECEPTION)
        .send({ payerId: cortesia })
        .expect(201);
    });

    it.each(PAYER_TYPES)(
      'SEC-049: every external generic type requires the member number; OTHER does not (%s)',
      async (type) => {
        const typed = await post(
          '/api/v1/payers',
          { name: `Pagador ${type}`, type },
          tokens.ADMIN,
        );
        const patient = await createPatient(`Tipo ${type}`);
        const res = await as(api().post(coverages(patient)), tokens.RECEPTION)
          .send({ payerId: typed })
          .expect(type === 'OTHER' ? 201 : 400);
        if (type !== 'OTHER') expect(message(res)).toBe(REQUIRED);
      },
    );

    it('SEC-049 audit carries the generic payer type', async () => {
      for (const type of PAYER_TYPES) {
        const typed = await post(
          '/api/v1/payers',
          { name: `Auditado ${type}`, type },
          tokens.ADMIN,
        );
        const patient = await createPatient(`Auditada ${type}`);
        await as(api().post(coverages(patient)), tokens.RECEPTION)
          .send({ payerId: typed, memberNumber: NUMBER })
          .expect(201);
        const created = (await coverageEvents(patient)).filter(
          (e) =>
            (e.metadata as { reason?: string }).reason === 'COVERAGE_CREATED',
        );
        expect(created).toHaveLength(1);
        expect(created[0].metadata).toMatchObject({
          coverage: { payerType: type },
        });
      }
    });

    it('legacy EMPRESA payer audits as EMPLOYER', async () => {
      // Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
      const rows = await raw.$queryRaw<{ id: string }[]>`
        INSERT INTO "payers" ("id", "tenantId", "name", "type", "updatedAt")
        VALUES (gen_random_uuid(), ${clinic.tenantId}::uuid, 'Empresa Alfa',
                'EMPRESA'::"PayerType", now())
        RETURNING "id"`;
      const patient = await createPatient('Auditada legado');
      await as(api().post(coverages(patient)), tokens.RECEPTION)
        .send({ payerId: rows[0].id, memberNumber: NUMBER })
        .expect(201);
      const events = (await coverageEvents(patient)).filter(
        (e) =>
          (e.metadata as { reason?: string }).reason === 'COVERAGE_CREATED',
      );
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toMatchObject({
        coverage: { payerType: 'EMPLOYER' },
      });
    });

    it('una cobertura migrada o anterior sin nº se lee igual, se edita en lo demás y habilita el convenio', async () => {
      const patient = await createPatient('Migrada');
      // Como el relleno de DX-153: sin autor, sin nº, marcada como migrada.
      const migrated = await raw.patientCoverage.create({
        data: {
          tenantId: clinic.tenantId,
          patientId: patient,
          payerId: payer,
          isPrimary: true,
          migratedFromInsurerEps: true,
        },
        select: { id: true },
      });
      const list = await as(api().get(coverages(patient)), tokens.RECEPTION)
        .expect(200)
        .then((r) => r.body as Record<string, unknown>[]);
      expect(list).toEqual([
        expect.objectContaining({
          id: migrated.id,
          memberNumber: null,
          migratedFromInsurerEps: true,
          declaredById: null,
          verifiedAt: null,
          verifiedById: null,
          verifiedByName: null,
          status: 'ACTIVE',
        }),
      ]);
      await as(
        api().patch(`${coverages(patient)}/${migrated.id}`),
        tokens.RECEPTION,
      )
        .send({ notes: 'Pedir el carné en la próxima cita' })
        .expect(200);
      // Migrada: la habilita para cualquier rol, como antes.
      await assign(patient, migrated.id, tokens.RECEPTION).expect(200);
    });

    it('quitar el nº de una cobertura de un pagador externo es 400', async () => {
      const patient = await createPatient('Quitar número');
      const coverageId = await createCoverage(patient, tokens.ADMIN);
      const res = await as(
        api().patch(`${coverages(patient)}/${coverageId}`),
        tokens.RECEPTION,
      )
        .send({ memberNumber: null })
        .expect(400);
      expect(message(res)).toBe(REQUIRED);
    });
  });

  describe('matriz rol × cobertura verificada × creada por sí mismo', () => {
    const matrix = ROLES.flatMap((role) =>
      [false, true].flatMap((verified) =>
        [true, false].map((self) => ({
          role,
          verified,
          self,
          status: role !== ClinicRole.ADMIN && self && !verified ? 403 : 200,
        })),
      ),
    );

    it.each(matrix)(
      '$role · verificada $verified · creada por sí mismo $self → $status',
      async ({ role, verified, self, status }) => {
        const patient = await createPatient(`${role} ${verified} ${self}`);
        // «De otro usuario»: el ADMIN la crea para los demás roles, y
        // recepción para el ADMIN.
        const creator = self
          ? role
          : role === ClinicRole.ADMIN
            ? ClinicRole.RECEPTION
            : ClinicRole.ADMIN;
        const coverageId = await createCoverage(patient, tokens[creator]);
        if (verified) await verify(patient, coverageId).expect(200);

        const res = await assign(patient, coverageId, tokens[role]);
        expect(res.status).toBe(status);
        const live = await raw.patientAgreement.findMany({
          where: { patientId: patient, deletedAt: null },
          select: { agreementId: true, coverageId: true, createdById: true },
        });
        const assigned = (await coverageEvents(patient)).filter(
          (e) =>
            (e.metadata as { reason?: string }).reason === 'AGREEMENT_ASSIGNED',
        );
        if (status === 403) {
          expect(message(res)).toBe(SELF_DECLARED);
          expect(live).toEqual([]);
          expect(assigned).toHaveLength(0);
        } else {
          expect(live).toEqual([
            { agreementId: agreement, coverageId, createdById: userIds[role] },
          ]);
          expect(assigned).toHaveLength(1);
        }
      },
    );

    it('la reproducción de BE-043: crear la cobertura y asignar en la llamada siguiente ya no vale', async () => {
      for (const role of [ClinicRole.ASSISTANT, ClinicRole.RECEPTION]) {
        const patient = await createPatient(`BE-043 ${role}`);
        const coverageId = await createCoverage(patient, tokens[role]);
        const res = await assign(patient, coverageId, tokens[role]).expect(403);
        expect(message(res)).toBe(SELF_DECLARED);
        await verify(patient, coverageId).expect(200);
        await assign(patient, coverageId, tokens[role]).expect(200);
      }
    });
  });

  describe('verificar', () => {
    it.each([ClinicRole.DENTIST, ClinicRole.ASSISTANT, ClinicRole.RECEPTION])(
      '%s no puede verificar: 403 en español y nada cambia',
      async (role) => {
        const patient = await createPatient(`Verifica ${role}`);
        const coverageId = await createCoverage(patient, tokens.ADMIN);
        const res = await verify(patient, coverageId, tokens[role]).expect(403);
        expect(message(res)).toBe(VERIFY_ADMIN_ONLY);
        const row = await raw.patientCoverage.findUniqueOrThrow({
          where: { id: coverageId },
          select: { verifiedAt: true, verifiedById: true },
        });
        expect(row).toEqual({ verifiedAt: null, verifiedById: null });
      },
    );

    it('ADMIN verifica: quién y cuándo en la respuesta y en la lista; auditado con su rol y solo los 4 últimos', async () => {
      const patient = await createPatient('Auditada');
      const coverageId = await createCoverage(patient, tokens.RECEPTION);
      const res = await verify(patient, coverageId).expect(200);
      expect(res.body).toMatchObject({
        id: coverageId,
        memberNumber: NUMBER,
        declaredById: userIds.RECEPTION,
        verifiedById: clinic.adminUserId,
        verifiedByName: 'Dr. Owner',
      });
      expect(
        Date.parse((res.body as { verifiedAt: string }).verifiedAt),
      ).not.toBeNaN();
      const listed = await as(api().get(coverages(patient)), tokens.DENTIST)
        .expect(200)
        .then((r) => (r.body as { verifiedByName: string | null }[])[0]);
      expect(listed.verifiedByName).toBe('Dr. Owner');

      const events = await coverageEvents(patient);
      const byReason = (reason: string) =>
        events.filter(
          (e) => (e.metadata as { reason?: string }).reason === reason,
        );
      expect(byReason('COVERAGE_CREATED')).toEqual([
        expect.objectContaining({
          actorRole: ClinicRole.RECEPTION,
          actorUserId: userIds.RECEPTION,
          metadata: expect.objectContaining({
            coverage: {
              payerType: 'EMPLOYER',
              memberNumberLast4: '4050',
              verified: false,
            },
          }) as unknown,
        }),
      ]);
      expect(byReason('COVERAGE_VERIFIED')).toEqual([
        expect.objectContaining({
          actorRole: ClinicRole.ADMIN,
          actorUserId: clinic.adminUserId,
          metadata: expect.objectContaining({
            coverage: {
              payerType: 'EMPLOYER',
              memberNumberLast4: '4050',
              verified: true,
            },
          }) as unknown,
        }),
      ]);
      // El número entero no está en ningún evento.
      expect(JSON.stringify(events)).not.toContain('102030');
    });

    it('editar el nº borra la verificación; quien lo editó vuelve a necesitarla para asignar', async () => {
      const patient = await createPatient('Editada');
      // La crea el ADMIN: para recepción es «de otro usuario»…
      const coverageId = await createCoverage(patient, tokens.ADMIN);
      await verify(patient, coverageId).expect(200);
      // …el mismo nº con otros espacios no cuenta como cambio…
      await as(
        api().patch(`${coverages(patient)}/${coverageId}`),
        tokens.RECEPTION,
      )
        .send({ memberNumber: ` ${NUMBER} `, notes: 'ok' })
        .expect(200)
        .then((r) =>
          expect(r.body).toMatchObject({
            verifiedById: clinic.adminUserId,
            declaredById: clinic.adminUserId,
          }),
        );
      // …pero cambiarlo la borra y la deja declarada por recepción.
      const changed = await as(
        api().patch(`${coverages(patient)}/${coverageId}`),
        tokens.RECEPTION,
      )
        .send({ memberNumber: '1020304059' })
        .expect(200);
      expect(changed.body).toMatchObject({
        verifiedAt: null,
        verifiedById: null,
        verifiedByName: null,
        declaredById: userIds.RECEPTION,
      });
      const res = await assign(patient, coverageId, tokens.RECEPTION).expect(
        403,
      );
      expect(message(res)).toBe(SELF_DECLARED);
      // Otro rol sí puede (la registró otro usuario), como pide el alcance.
      await assign(patient, coverageId, tokens.ASSISTANT).expect(200);
      const changedEvent = (await coverageEvents(patient)).filter(
        (e) =>
          (e.metadata as { reason?: string }).reason === 'COVERAGE_CHANGED',
      );
      expect(changedEvent.at(-1)?.metadata).toMatchObject({
        coverage: { memberNumberLast4: '4059', verified: false },
      });
    });

    it('409 si el nº cambió mientras el ADMIN lo revisaba; 400 sin nº', async () => {
      const patient = await createPatient('Carrera');
      const coverageId = await createCoverage(patient, tokens.ADMIN);
      const res = await verify(
        patient,
        coverageId,
        tokens.ADMIN,
        '1020304051',
      ).expect(409);
      expect(message(res)).toBe(VERIFY_STALE);

      const legacy = await raw.patientCoverage.create({
        data: { tenantId: clinic.tenantId, patientId: patient, payerId: payer },
        select: { id: true },
      });
      const noNumber = await verify(patient, legacy.id).expect(400);
      expect(message(noNumber)).toBe(
        'Escribe antes el nº de afiliado: sin él no se puede verificar la cobertura.',
      );
    });
  });

  describe('dos clínicas', () => {
    it('la cobertura verificada de otra clínica no habilita nada ni dice nada de ella', async () => {
      const patient = await createPatient('Intrusa');
      for (const role of ROLES) {
        const res = await assign(patient, foreignCoverage, tokens[role]).expect(
          400,
        );
        expect(message(res)).toBe(COVERAGE_NOT_FOUND);
      }
      expect(
        await raw.patientAgreement.count({ where: { patientId: patient } }),
      ).toBe(0);
    });

    it('verificar una cobertura o un paciente de otra clínica es 404 sin datos', async () => {
      const patient = await createPatient('Propia');
      const own = await verify(patient, foreignCoverage).expect(404);
      expect(message(own)).toBe(COVERAGE_NOT_FOUND);
      const foreign = await verify(foreignPatient, foreignCoverage).expect(404);
      expect(message(foreign)).toBe('Paciente no encontrado.');
      for (const res of [own, foreign]) {
        expect(JSON.stringify(res.body)).not.toMatch(/9988|6655|Aseguradora/);
      }
      const row = await raw.patientCoverage.findUniqueOrThrow({
        where: { id: foreignCoverage },
        select: { verifiedById: true },
      });
      expect(row.verifiedById).toBe(other.adminUserId);
    });
  });
});
