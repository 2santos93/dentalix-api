import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, DocType, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';

// SEC-005 — POST /patients con `medicalHistory` crea la anamnesis v1, que es
// historia clínica (CLINICAL_ROLES). Recepción crea pacientes, pero sin ese
// campo: si lo manda, 403 explícito y no se crea nada. DIRECT_URL (sin RLS)
// solo para sembrar miembros con rol, comprobar filas y limpiar.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const PASSWORD = 'S3cret!!';
const SUBDOMAIN = 'alta-anamnesis';

const MEDICAL_HISTORY = {
  allergies: [
    {
      alergeno: 'Penicilina',
      tipo: 'MEDICAMENTO',
      severidad: 'ANAFILAXIA',
      esAlerta: true,
    },
  ],
};

async function cleanup(): Promise<void> {
  await raw.medicalHistoryVersion.deleteMany();
  await raw.patient.deleteMany();
  await raw.location.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenantDomain.deleteMany();
  await raw.tenant.deleteMany();
}

describe('Alta de paciente con anamnesis inicial según rol — POST /patients (e2e)', () => {
  let app: INestApplication<App>;
  let tenantId: string;
  const tokens = {} as Record<ClinicRole, string>;

  const server = () => app.getHttpServer();

  async function login(email: string): Promise<string> {
    const res = await request(server())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', hostFor(SUBDOMAIN))
      .send({ email, password: PASSWORD })
      .expect(201);
    return (res.body as { accessToken: string }).accessToken;
  }

  async function member(role: ClinicRole): Promise<string> {
    const email = `${role.toLowerCase()}@${SUBDOMAIN}.com`;
    const user = await raw.user.create({
      data: {
        email,
        passwordHash: await passwordService.hash(PASSWORD),
        fullName: `Staff ${role}`,
        emailVerifiedAt: new Date(),
      },
      select: { id: true },
    });
    await raw.clinicMembership.create({
      data: { tenantId, userId: user.id, role },
    });
    return login(email);
  }

  function createPatient(
    role: ClinicRole,
    docNumber: string,
    withHistory: boolean,
  ) {
    return request(server())
      .post('/api/v1/patients')
      .set('X-Tenant-Host', hostFor(SUBDOMAIN))
      .set('Authorization', `Bearer ${tokens[role]}`)
      .send({
        firstName: 'Ana',
        lastName: 'Alta',
        docType: DocType.CC,
        docNumber,
        sex: Sex.F,
        ...(withHistory ? { medicalHistory: MEDICAL_HISTORY } : {}),
      });
  }

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await cleanup();

    const email = `owner@${SUBDOMAIN}.com`;
    const reg = await registerVerified(app, {
      clinicName: 'Clinica Alta',
      subdomain: SUBDOMAIN,
      email,
      password: PASSWORD,
      fullName: 'Dra. Admin',
    });
    tenantId = (reg.body as { tenantId: string }).tenantId;
    tokens[ClinicRole.ADMIN] = await login(email);
    tokens[ClinicRole.RECEPTION] = await member(ClinicRole.RECEPTION);
    tokens[ClinicRole.DENTIST] = await member(ClinicRole.DENTIST);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('RECEPTION con medicalHistory -> 403 explícito, sin paciente ni anamnesis', async () => {
    const res = await createPatient(ClinicRole.RECEPTION, 'ALTA-R1', true);

    expect(res.status).toBe(403);
    expect((res.body as { message: string }).message).toMatch(
      /historia clínica/,
    );
    expect(
      await raw.patient.count({ where: { tenantId, docNumber: 'ALTA-R1' } }),
    ).toBe(0);
    expect(await raw.medicalHistoryVersion.count({ where: { tenantId } })).toBe(
      0,
    );
  });

  it('RECEPTION sin medicalHistory -> 201, sin anamnesis', async () => {
    const res = await createPatient(ClinicRole.RECEPTION, 'ALTA-R2', false);

    expect(res.status).toBe(201);
    expect(
      await raw.medicalHistoryVersion.count({
        where: { patientId: (res.body as { id: string }).id },
      }),
    ).toBe(0);
  });

  it.each([ClinicRole.DENTIST, ClinicRole.ADMIN])(
    '%s sigue creando la anamnesis v1 en el alta',
    async (role) => {
      const res = await createPatient(role, `ALTA-${role}`, true);

      expect(res.status).toBe(201);
      const versions = await raw.medicalHistoryVersion.findMany({
        where: { patientId: (res.body as { id: string }).id },
        select: { version: true, hasCriticalAlert: true },
      });
      expect(versions).toEqual([{ version: 1, hasCriticalAlert: true }]);
    },
  );
});
