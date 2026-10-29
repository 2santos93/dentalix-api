import { randomUUID } from 'node:crypto';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { applyBodyLimits } from '../src/config/body-limits';
import { PasswordService } from '../src/shared/crypto/password.service';
import {
  computePrescriptionHash,
  expectedPrescriptionHash,
  type LegacyPrescriptionHashInput,
  type StoredPrescriptionHashInput,
} from '../src/modules/prescriptions/domain/prescription-hash';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import {
  REGIONAL_NEW_YORK_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  locationBody,
  registerBody,
  type RegionalFixture,
} from './support/location-fixtures';

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

interface RxBody {
  id: string;
  status: 'ISSUED' | 'VOIDED';
  country: 'CO' | 'ES' | null;
  locationId: string;
  locationName: string;
  professionalId: string;
  professionalName: string;
  professionalLicense: string;
  issuedAt: string;
  dispensationDate: string;
  validUntil: string;
  patientDocument: string | null;
  patientBirthYear: number | null;
  patientAgeYears: number | null;
  patientWeightKg: number | null;
  clinicalRecordNumber: string | null;
  professionalSpecialty: string | null;
  allergyOverride: boolean;
  allergyMatches: { activeIngredient: string; allergen: string }[];
  contentHash: string;
  voidedAt: string | null;
  voidedById: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  integrityOk?: boolean;
  locationFormat?: {
    timeZone: string | null;
    locale: string | null;
    hourCycle: 'h12' | 'h23' | null;
  };
  items: {
    position: number;
    activeIngredient: string;
    quantityInWords: string | null;
    packages: number | null;
  }[];
}

interface RxSettings {
  words: boolean;
  hc: boolean;
  days: number;
}
/** Los ajustes con los que siembra este fichero: letras, nº de HC y 30 días. */
const SETTINGS_ON: RxSettings = { words: true, hc: true, days: 30 };

/**
 * Ajustes de la receta de la clínica, por SQL para no dejar eventos de
 * auditoría en cada test. `PUT /prescriptions/settings` tiene su propio spec
 * (`prescription-settings.e2e-spec.ts`).
 */
async function setRxSettings(
  tenantId: string,
  { words, hc, days }: RxSettings,
): Promise<void> {
  await raw.$executeRaw`
    UPDATE "tenants"
       SET "prescriptionPrintQuantityInWords" = ${words},
           "prescriptionRequireClinicalRecordNumber" = ${hc},
           "prescriptionValidityDays" = ${days}
     WHERE "id" = ${tenantId}::uuid`;
}

const dayOnly = (value: Date) => value.toISOString().slice(0, 10);

/** El hash recalculado con la fila leída de la BD, como hace la API al leer. */
async function hashOfStoredRow(
  id: string,
  override: Partial<StoredPrescriptionHashInput> = {},
): Promise<{ stored: string; computed: string | null }> {
  const row = await raw.prescription.findUniqueOrThrow({
    where: { id },
    include: { items: { orderBy: { position: 'asc' } } },
  });
  const input: StoredPrescriptionHashInput = {
    ...row,
    dispensationDate: dayOnly(row.dispensationDate),
    validUntil: dayOnly(row.validUntil),
    allergyMatches:
      row.allergyMatches as unknown as StoredPrescriptionHashInput['allergyMatches'],
    safetyAlerts:
      row.safetyAlerts as unknown as StoredPrescriptionHashInput['safetyAlerts'],
    items: row.items.map(
      ({ id: _id, tenantId: _t, prescriptionId: _p, ...item }) => item,
    ),
    ...override,
  };
  return { stored: row.contentHash, computed: expectedPrescriptionHash(input) };
}

const SUBDOMAINS = ['rx-a', 'rx-b'];

async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  const where = { tenantId: { in: ids } };
  await raw.prescription.deleteMany({ where });
  await raw.prescriptionTemplate.deleteMany({ where });
  await raw.medicalHistoryVersion.deleteMany({ where });
  await raw.dataProcessingConsent.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.locationScheduleRange.deleteMany({ where });
  await raw.locationSchedule.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.clinicMembership.deleteMany({ where });
  await raw.tenantDomain.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: { in: ids } } });
  await raw.user.deleteMany({
    where: {
      OR: SUBDOMAINS.map((s) => ({ email: { endsWith: `@${s}.com` } })),
    },
  });
}

const amoxicilina = {
  activeIngredient: 'Amoxicilina',
  concentration: '500 mg',
  pharmaceuticalForm: 'Cápsula',
  route: 'Oral',
  dose: '1 cápsula',
  frequency: 'Cada 8 horas',
  durationDays: 7,
  totalQuantity: 21,
  quantityUnit: 'cápsulas',
};
const ibuprofeno = {
  activeIngredient: 'Ibuprofeno',
  concentration: '600 mg',
  pharmaceuticalForm: 'Tableta',
  route: 'Oral',
  dose: '1 tableta',
  frequency: 'Cada 8 horas',
  durationDays: 3,
  totalQuantity: 9,
  quantityUnit: 'tabletas',
};

describe('Recetas — /patients/:id/prescriptions, /prescriptions, /prescription-templates (e2e)', () => {
  let app: INestApplication<App>;
  let clinicA: Session;
  let clinicB: Session;
  let dentistA: { token: string; userId: string };
  let dentist2A: { token: string; userId: string };
  let assistantA: string;
  let receptionA: string;
  let patientA: string;
  let allergicA: string;
  let patientB: string;
  let locationB: string;
  let rxId: string;

  const server = () => app.getHttpServer();

  function as(
    session: Session,
    token = session.accessToken,
    locationId?: string,
  ) {
    const withAuth = (req: request.Test) => {
      const r = req
        .set('X-Tenant-Host', hostFor(session.subdomain))
        .set('Authorization', `Bearer ${token}`);
      return locationId ? r.set('X-Location-Id', locationId) : r;
    };
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
      registerBody(REGIONAL_NEW_YORK_FIXTURE, {
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
    tag: string,
    professionalLicense?: string,
  ): Promise<{ token: string; userId: string }> {
    const email = `${tag}@${session.subdomain}.com`;
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
      data: {
        tenantId: session.tenantId,
        userId: user.id,
        role,
        professionalLicense,
      },
    });
    return { token: await login(session.subdomain, email), userId: user.id };
  }

  async function createPatient(
    session: Session,
    firstName: string,
    docNumber?: string,
    birthDate?: string,
    doc: { docType?: string; docTypeLabel?: string } = {},
  ): Promise<string> {
    const res = await as(session)
      .post('/patients', {
        firstName,
        lastName: 'Receta',
        docType: 'NATIONAL_ID',
        docNumber,
        birthDate,
        sex: Sex.F,
        ...doc,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  }

  const rxPath = (patientId: string) => `/patients/${patientId}/prescriptions`;

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
    await app.listen(0, '127.0.0.1');
    await cleanup();

    clinicA = await register('rx-a');
    clinicB = await register('rx-b');
    dentistA = await member(
      clinicA,
      ClinicRole.DENTIST,
      'Dra. Laura Ruiz',
      'dentist',
      'RM-12345',
    );
    dentist2A = await member(
      clinicA,
      ClinicRole.DENTIST,
      'Dr. Segundo',
      'dentist2',
      'RM-999',
    );
    assistantA = (
      await member(clinicA, ClinicRole.ASSISTANT, 'Asistente', 'assistant')
    ).token;
    receptionA = (
      await member(clinicA, ClinicRole.RECEPTION, 'Recepción', 'reception')
    ).token;
    patientA = await createPatient(clinicA, 'Ana', 'RX-A-1');
    allergicA = await createPatient(clinicA, 'Alba', 'RX-A-2');
    patientB = await createPatient(clinicB, 'Carla', 'RX-B-1');
    locationB = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinicB.tenantId },
      })
    ).id;
    await setRxSettings(clinicA.tenantId, SETTINGS_ON);

    await as(clinicA, dentistA.token)
      .put(`/patients/${allergicA}/medical-history`, {
        allergies: [
          {
            alergeno: 'Penicilina',
            tipo: 'MEDICAMENTO',
            severidad: 'ANAFILAXIA',
            esAlerta: true,
          },
        ],
      })
      .expect(200);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  describe('emitir', () => {
    it('issuer carries the deprecated legacy country of its location (phase 1, old web)', async () => {
      const res = await as(clinicA, dentistA.token)
        .get('/prescriptions/issuer')
        .expect(200);
      const issuerBody = res.body as { locationId: string; country: unknown };
      expect(res.body).toMatchObject({
        professionalName: 'Dra. Laura Ruiz',
        professionalLicense: 'RM-12345',
        professionalSpecialty: null,
        validityDays: 30,
        maxItems: 10,
        printQuantityInWords: true,
        requireClinicalRecordNumber: true,
      });
      const site = await raw.location.findUniqueOrThrow({
        where: { id: issuerBody.locationId },
        select: { country: true },
      });
      expect(issuerBody.country).toBe(site.country);
      expect(res.body).not.toHaveProperty('phase1');
      // La forma que lee la web de main: «Sede (país)» con un país conocido.
      expect(['CO', 'ES']).toContain(issuerBody.country);
    });

    it('un DENTIST emite con 2 medicamentos: foto legal, cantidad en letras y hash; autor y hora del servidor', async () => {
      const before = Date.now();
      const res = await as(clinicA, dentistA.token)
        .post(rxPath(patientA), {
          items: [amoxicilina, ibuprofeno],
          notes: 'Tomar con alimentos',
          // Ignorados (whitelist): nunca del cliente.
          professionalId: dentist2A.userId,
          issuedAt: '2020-01-01T00:00:00.000Z',
          tenantId: clinicB.tenantId,
        })
        .expect(201);
      const rx = res.body as RxBody;
      expect(rx).toMatchObject({
        status: 'ISSUED',
        country: null,
        professionalId: dentistA.userId,
        professionalLicense: 'RM-12345',
        clinicalRecordNumber: 'RX-A-1',
        patientDocument: 'Documento nacional RX-A-1',
        allergyOverride: false,
      });
      expect(new Date(rx.issuedAt).getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );
      expect(
        rx.items.map((i) => [
          i.position,
          i.activeIngredient,
          i.quantityInWords,
        ]),
      ).toEqual([
        [1, 'Amoxicilina', 'veintiuno'],
        [2, 'Ibuprofeno', 'nueve'],
      ]);
      expect(rx.contentHash).toMatch(/^[0-9a-f]{64}$/);
      const start = new Date(`${rx.dispensationDate}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() + 29);
      expect(rx.validUntil).toBe(start.toISOString().slice(0, 10));
      rxId = rx.id;

      const doc = await as(clinicA, assistantA)
        .get(`/prescriptions/${rxId}`)
        .expect(200);
      expect((doc.body as RxBody).integrityOk).toBe(true);
    });

    it('falta un campo → 400 en español con todos los que faltan', async () => {
      const res = await as(clinicA, dentistA.token)
        .post(rxPath(patientA), {
          items: [{ ...amoxicilina, dose: '', totalQuantity: undefined }],
        })
        .expect(400);
      expect((res.body as { message: string }).message).toBe(
        'No se puede emitir la receta: Medicamento 1: falta la dosis; Medicamento 1: falta la cantidad total.',
      );
      const typed = await as(clinicA, dentistA.token)
        .post(rxPath(patientA), {
          items: [{ ...amoxicilina, durationDays: 'siete' }],
        })
        .expect(400);
      expect(JSON.stringify(typed.body)).toContain(
        'La duración debe ser un número entero',
      );
    });

    it('sin registro profesional: 400; lo introduce al emitir y queda en la receta y en su perfil', async () => {
      const res = await as(clinicA)
        .post(rxPath(patientA), { items: [amoxicilina] })
        .expect(400);
      expect((res.body as { message: string }).message).toContain(
        'Falta tu número de registro profesional',
      );
      const ok = await as(clinicA)
        .post(rxPath(patientA), {
          items: [amoxicilina],
          professionalLicense: 'TP-55',
        })
        .expect(201);
      expect((ok.body as RxBody).professionalLicense).toBe('TP-55');
      const owner = await raw.clinicMembership.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId, role: ClinicRole.ADMIN },
      });
      expect(owner.professionalLicense).toBe('TP-55');

      // Con el registro ya en el perfil, el del cuerpo se ignora: ni se sella
      // ni pisa el perfil (eso solo lo hace un ADMIN en Personal).
      const again = await as(clinicA)
        .post(rxPath(patientA), {
          items: [amoxicilina],
          professionalLicense: 'OTRO-1',
        })
        .expect(201);
      expect((again.body as RxBody).professionalLicense).toBe('TP-55');
      const ownerAfter = await raw.clinicMembership.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId, role: ClinicRole.ADMIN },
      });
      expect(ownerAfter.professionalLicense).toBe('TP-55');
    });

    it('un odontólogo no puede editar el registro de otro miembro en Personal (403)', async () => {
      await as(clinicA, dentistA.token)
        .patch(`/staff/${dentist2A.userId}`, { professionalLicense: 'X-1' })
        .expect(403);
    });

    it('el ADMIN edita el registro profesional de un miembro en Personal', async () => {
      await as(clinicA)
        .patch(`/staff/${dentist2A.userId}`, {
          professionalLicense: ' RM-2024 ',
        })
        .expect(200);
      const detail = await as(clinicA)
        .get(`/staff/${dentist2A.userId}`)
        .expect(200);
      expect(
        (detail.body as { professionalLicense: string }).professionalLicense,
      ).toBe('RM-2024');
    });
  });

  describe('alerta de alergia', () => {
    it('409 sin confirmación, con las coincidencias; no se guarda nada', async () => {
      const res = await as(clinicA, dentistA.token)
        .post(rxPath(allergicA), { items: [amoxicilina] })
        .expect(409);
      expect(res.body).toMatchObject({
        message: expect.stringContaining(
          'Avisos de seguridad sin confirmar',
        ) as string,
        allergyMatches: [
          { activeIngredient: 'Amoxicilina', allergen: 'Penicilina' },
        ],
      });
      const list = await as(clinicA, dentistA.token)
        .get(rxPath(allergicA))
        .expect(200);
      expect(list.body).toEqual([]);
    });

    it('con allergyOverride=true (cliente anterior) y motivo emite y guarda la confirmación', async () => {
      await as(clinicA, dentistA.token)
        .post(rxPath(allergicA), {
          items: [amoxicilina],
          allergyOverride: true,
        })
        .expect(409);
      const res = await as(clinicA, dentistA.token)
        .post(rxPath(allergicA), {
          items: [amoxicilina],
          allergyOverride: true,
          safetyOverrideReason: 'Prueba cutánea negativa',
        })
        .expect(201);
      expect(res.body).toMatchObject({
        allergyOverride: true,
        allergyMatches: [
          { activeIngredient: 'Amoxicilina', allergen: 'Penicilina' },
        ],
        safetyOverrideReason: 'Prueba cutánea negativa',
      });
    });
  });

  describe('receta segura (DX-300)', () => {
    const metronidazol = {
      ...amoxicilina,
      activeIngredient: 'Metronidazol',
      dose: '1 tableta',
      quantityUnit: 'tabletas',
    };
    const paracetamol = { ...ibuprofeno, activeIngredient: 'Paracetamol' };
    const check = (patientId: string, items: object[]) =>
      as(clinicA, dentistA.token).post(`${rxPath(patientId)}/safety-check`, {
        items,
      });
    interface Preview {
      anamnesis: 'PRESENT' | 'MISSING';
      hasBlocking: boolean;
      alerts: { code: string; severity: string; message: string }[];
    }
    const codesOf = (body: unknown) =>
      (body as Preview).alerts.map((a) => a.code);

    let penFlagA: string;
    let warfarinA: string;
    let pregnantA: string;
    let childA: string;
    let childNoWeightA: string;

    beforeAll(async () => {
      const sixYearsAgo = new Date();
      sixYearsAgo.setUTCFullYear(sixYearsAgo.getUTCFullYear() - 6);
      sixYearsAgo.setUTCMonth(sixYearsAgo.getUTCMonth() - 1);
      const childBirth = sixYearsAgo.toISOString().slice(0, 10);
      penFlagA = await createPatient(clinicA, 'Pena', 'RX-A-10');
      warfarinA = await createPatient(
        clinicA,
        'Wanda',
        'RX-A-11',
        '1970-01-01',
      );
      pregnantA = await createPatient(clinicA, 'Paula', 'RX-A-12');
      childA = await createPatient(clinicA, 'Nico', 'RX-A-13', childBirth);
      childNoWeightA = await createPatient(
        clinicA,
        'Nora',
        'RX-A-14',
        childBirth,
      );

      // La casilla «Alergia a penicilina» marcada con la lista vacía (p. ej.
      // una versión importada): solo se puede escribir así.
      await raw.medicalHistoryVersion.create({
        data: {
          tenantId: clinicA.tenantId,
          patientId: penFlagA,
          version: 1,
          allergies: [],
          safetyFlags: { alergiaPenicilina: true },
          hasCriticalAlert: true,
        },
      });
      await as(clinicA, dentistA.token)
        .put(`/patients/${warfarinA}/medical-history`, {
          medications: [{ nombre: 'Warfarina 5 mg', esAlerta: true }],
        })
        .expect(200);
      await as(clinicA, dentistA.token)
        .put(`/patients/${pregnantA}/medical-history`, {
          embarazo: true,
          semanasEmbarazo: 24,
        })
        .expect(200);
      await as(clinicA, dentistA.token)
        .put(`/patients/${childA}/medical-history`, {
          vitalSigns: { peso: 20 },
        })
        .expect(200);
      await as(clinicA, dentistA.token)
        .put(`/patients/${childNoWeightA}/medical-history`, {})
        .expect(200);
    });

    it('casilla «Alergia a penicilina» con la lista vacía: la previsualización avisa y emitir sin confirmación da 409', async () => {
      const preview = await check(penFlagA, [amoxicilina]).expect(200);
      expect(preview.body).toMatchObject({
        anamnesis: 'PRESENT',
        hasBlocking: true,
        alerts: [{ code: 'ALLERGY_MATCH', severity: 'BLOCKING' }],
      });
      const res = await as(clinicA, dentistA.token)
        .post(rxPath(penFlagA), { items: [amoxicilina] })
        .expect(409);
      expect((res.body as { message: string }).message).toContain('penicilina');
    });

    it('warfarina: ibuprofeno y metronidazol bloquean; 409 sin motivo, 201 con confirmación y motivo en safetyAlerts, en el hash y en la auditoría', async () => {
      expect(codesOf((await check(warfarinA, [ibuprofeno])).body)).toEqual([
        'INTERACTION_ANTICOAGULANT_NSAID',
      ]);
      expect(codesOf((await check(warfarinA, [metronidazol])).body)).toEqual([
        'INTERACTION_ANTICOAGULANT_METRONIDAZOLE',
      ]);
      await as(clinicA, dentistA.token)
        .post(rxPath(warfarinA), { items: [ibuprofeno] })
        .expect(409);
      const noReason = await as(clinicA, dentistA.token)
        .post(rxPath(warfarinA), { items: [ibuprofeno], safetyOverride: true })
        .expect(409);
      expect((noReason.body as { message: string }).message).toContain(
        'Escribe el motivo',
      );

      const res = await as(clinicA, dentistA.token)
        .post(rxPath(warfarinA), {
          items: [ibuprofeno],
          safetyOverride: true,
          safetyOverrideReason: 'INR estable; pauta de 2 días',
        })
        .expect(201);
      const body = res.body as RxBody & {
        safetyRulesVersion: string;
        safetyAlerts: { code: string; severity: string }[];
        safetyOverrideReason: string;
      };
      expect(body.safetyRulesVersion).toBe('RX_SAFETY_V1');
      expect(body.safetyOverrideReason).toBe('INR estable; pauta de 2 días');
      expect(body.safetyAlerts).toEqual([
        expect.objectContaining({
          code: 'INTERACTION_ANTICOAGULANT_NSAID',
          severity: 'BLOCKING',
        }),
      ]);
      const doc = await as(clinicA, dentistA.token)
        .get(`/prescriptions/${body.id}`)
        .expect(200);
      expect((doc.body as RxBody).integrityOk).toBe(true);

      const event = await raw.auditEvent.findFirstOrThrow({
        where: {
          tenantId: clinicA.tenantId,
          resourceId: body.id,
          action: 'CREATE',
        },
      });
      expect(event.metadata).toMatchObject({
        prescriptionSafety: {
          rulesVersion: 'RX_SAFETY_V1',
          blocking: ['INTERACTION_ANTICOAGULANT_NSAID'],
          info: [],
          overridden: true,
        },
      });
      expect(JSON.stringify(event.metadata)).not.toContain('Warfarina');
    });

    it('embarazo de 24 semanas: un AINE bloquea; paracetamol no', async () => {
      const nsaid = await check(pregnantA, [ibuprofeno]).expect(200);
      expect(codesOf(nsaid.body)).toEqual(['PREGNANCY_NSAID']);
      const ok = await check(pregnantA, [paracetamol]).expect(200);
      expect(ok.body).toMatchObject({ hasBlocking: false, alerts: [] });
    });

    it('niño de 6 años y 20 kg: amoxicilina 1 g/8 h supera el tope; sin peso pide el peso; un adulto no tiene aviso de dosis', async () => {
      const amox1g = { ...amoxicilina, concentration: '1 g', dose: '1 g' };
      const child = await check(childA, [amox1g]).expect(200);
      expect((child.body as Preview).alerts).toEqual([
        expect.objectContaining({
          code: 'PEDIATRIC_DOSE_EXCEEDED',
          severity: 'BLOCKING',
          message: expect.stringContaining('50 mg/kg/toma') as string,
        }),
      ]);
      const noWeight = await check(childNoWeightA, [amox1g]).expect(200);
      expect((noWeight.body as Preview).alerts[0].message).toContain(
        'Registra el peso para comprobar la dosis',
      );
      const adult = await check(warfarinA, [amox1g]).expect(200);
      expect(adult.body).toMatchObject({ alerts: [] });
    });

    it('sin anamnesis: la previsualización lo dice y la receta lo registra', async () => {
      const noHistory = await createPatient(clinicA, 'Sina', 'RX-A-15');
      const preview = await check(noHistory, [amoxicilina]).expect(200);
      expect(preview.body).toMatchObject({
        anamnesis: 'MISSING',
        hasBlocking: false,
        alerts: [
          {
            code: 'NO_ANAMNESIS',
            message:
              'Sin anamnesis vigente: no se han podido comprobar alergias ni interacciones',
          },
        ],
      });
      const res = await as(clinicA, dentistA.token)
        .post(rxPath(noHistory), { items: [amoxicilina] })
        .expect(201);
      expect(
        (res.body as { safetyAlerts: { code: string }[] }).safetyAlerts.map(
          (a) => a.code,
        ),
      ).toEqual(['NO_ANAMNESIS']);
    });

    it('la previsualización: solo quien emite, 404 desde otra clínica, 400 en español', async () => {
      await as(clinicA, assistantA)
        .post(`${rxPath(warfarinA)}/safety-check`, { items: [] })
        .expect(403);
      await as(clinicA, receptionA)
        .post(`${rxPath(warfarinA)}/safety-check`, { items: [] })
        .expect(403);
      await as(clinicB)
        .post(`${rxPath(warfarinA)}/safety-check`, { items: [ibuprofeno] })
        .expect(404);
      const bad = await check(warfarinA, [{ activeIngredient: 5 }]).expect(400);
      expect(JSON.stringify(bad.body)).toContain('El principio activo');
    });
  });

  describe('ajustes de la receta en dos sedes de formatos distintos', () => {
    // Sede A con formato en-US y reloj de 12 h; sede B con ja-JP y 24 h.
    let siteA: string;
    let siteB: string;
    let noDocA: string;

    async function createSite(
      regional: RegionalFixture,
      name: string,
    ): Promise<string> {
      const res = await as(clinicA)
        .post('/locations', locationBody(regional, { name, address: name }))
        .expect(201);
      return (res.body as { id: string }).id;
    }

    const issueAt = (site: string | undefined, patientId: string, body = {}) =>
      as(clinicA, dentistA.token, site).post(rxPath(patientId), {
        items: [amoxicilina],
        ...body,
      });

    async function setSpecialty(userId: string, value: string): Promise<void> {
      await as(clinicA)
        .patch(`/staff/${userId}`, { professionalSpecialty: value })
        .expect(200);
    }

    const yearsAgo = (years: number) => {
      const date = new Date();
      date.setUTCFullYear(date.getUTCFullYear() - years);
      date.setUTCMonth(date.getUTCMonth() - 1);
      return dayOnly(date);
    };

    beforeAll(async () => {
      siteA = await createSite(REGIONAL_NEW_YORK_FIXTURE, 'Sede A');
      siteB = await createSite(REGIONAL_TOKYO_FIXTURE, 'Sede B');
      noDocA = await createPatient(clinicA, 'Nadia');
    });

    afterEach(() => setRxSettings(clinicA.tenantId, SETTINGS_ON));

    it('a five-item prescription with no packages and no birth date is 201 at every location', async () => {
      const five = Array.from({ length: 5 }, (_, i) => ({
        ...amoxicilina,
        activeIngredient: `Principio ${i + 1}`,
      }));
      for (const site of [undefined, siteA, siteB]) {
        const res = await issueAt(site, patientA, { items: five }).expect(201);
        const rx = res.body as RxBody;
        expect({ site, packages: rx.items.map((i) => i.packages) }).toEqual({
          site,
          packages: [null, null, null, null, null],
        });
        expect(rx).toMatchObject({
          patientBirthYear: null,
          patientAgeYears: null,
        });
      }
    });

    it('the same settings give the same rules at a ja-JP/Asia/Tokyo/JPY location and at an en-US/America/New_York/USD one', async () => {
      await setRxSettings(clinicA.tenantId, {
        words: true,
        hc: true,
        days: 30,
      });
      for (const site of [siteA, siteB]) {
        const noDoc = await issueAt(site, noDocA).expect(400);
        expect({
          site,
          message: (noDoc.body as { message: string }).message,
        }).toEqual({
          site,
          message:
            'No se puede emitir la receta: Falta el número de historia clínica: registra el documento del paciente en sus datos.',
        });
        const on = (await issueAt(site, patientA).expect(201)).body as RxBody;
        expect(on.items[0].quantityInWords).toBe('veintiuno');
        expect(on.clinicalRecordNumber).toBe('RX-A-1');
      }

      await setRxSettings(clinicA.tenantId, {
        words: false,
        hc: false,
        days: 30,
      });
      for (const site of [siteA, siteB]) {
        const res = await issueAt(site, noDocA).expect(201);
        const rx = res.body as RxBody;
        expect(rx).toMatchObject({
          country: null,
          clinicalRecordNumber: null,
          patientDocument: null,
        });
        expect(rx.items[0].quantityInWords).toBeNull();
        // Fase 1 (spec D1): la fila sigue llevando el país de la sede y las
        // letras, para las réplicas anteriores.
        const [row] = await raw.$queryRaw<
          {
            country: string | null;
            siteCountry: string;
            singleFormat: boolean;
            printQuantityInWords: boolean | null;
            quantityInWords: string;
          }[]
        >`
          SELECT p."country"::text AS "country", l."country"::text AS "siteCountry",
                 p."singleFormat", p."printQuantityInWords", i."quantityInWords"
            FROM "prescriptions" p
            JOIN "locations" l ON l."id" = p."locationId"
            JOIN "prescription_items" i ON i."prescriptionId" = p."id"
           WHERE p."id" = ${rx.id}::uuid`;
        expect(row).toEqual({
          country: row.siteCountry,
          siteCountry: expect.any(String) as string,
          singleFormat: true,
          printQuantityInWords: false,
          quantityInWords: 'veintiuno',
        });
      }
    });

    it('legacy columns: a new prescription copies the country of its location as data and applies none of its rules', async () => {
      const site = await createSite(REGIONAL_TOKYO_FIXTURE, 'Sede legado');
      await raw.$executeRaw`
        UPDATE "locations" SET "country" = 'ES' WHERE "id" = ${site}::uuid`;
      // Fase 1: la vista del emisor reenvía el país guardado de ESTA sede
      // (deprecated, para la web anterior), no uno por defecto.
      const issuer = await as(clinicA, dentistA.token, site)
        .get('/prescriptions/issuer')
        .expect(200);
      expect(issuer.body).toMatchObject({ locationId: site, country: 'ES' });
      // Varios medicamentos, sin envases y sin fecha de nacimiento: la regla
      // del país copiado no se aplica.
      const res = await issueAt(site, patientA, {
        items: [amoxicilina, ibuprofeno],
      }).expect(201);
      const rx = res.body as RxBody;
      expect(rx.country).toBeNull();
      expect(rx.patientDocument).toBe('Documento nacional RX-A-1');
      const row = await raw.prescription.findUniqueOrThrow({
        where: { id: rx.id },
        include: { items: { orderBy: { position: 'asc' } } },
      });
      expect(row.country).toBe('ES');
      expect(row.items.map((i) => i.quantityInWords)).toEqual([
        'veintiuno',
        'nueve',
      ]);
      const doc = await as(clinicA, dentistA.token)
        .get(`/prescriptions/${rx.id}`)
        .expect(200);
      expect(doc.body).toMatchObject({ country: null, integrityOk: true });
    });

    it('validity follows validityDays (1, 30, 365)', async () => {
      for (const days of [1, 30, 365]) {
        await setRxSettings(clinicA.tenantId, { ...SETTINGS_ON, days });
        const rx = (await issueAt(siteB, patientA).expect(201)).body as RxBody;
        const until = new Date(`${rx.dispensationDate}T00:00:00Z`);
        until.setUTCDate(until.getUTCDate() + days - 1);
        expect({ days, validUntil: rx.validUntil }).toEqual({
          days,
          validUntil: dayOnly(until),
        });
      }
    });

    it('issued snapshot is single format, age, weight, specialty and the v3 hash', async () => {
      const vera = await createPatient(
        clinicA,
        'Vera',
        'RX-A-30',
        yearsAgo(30),
      );
      await as(clinicA, dentistA.token)
        .put(`/patients/${vera}/medical-history`, { vitalSigns: { peso: 64 } })
        .expect(200);
      await setSpecialty(dentistA.userId, 'Cirugía oral');
      const res = await issueAt(siteB, vera).expect(201);
      const rx = res.body as RxBody;
      expect(rx).toMatchObject({
        country: null,
        patientAgeYears: 30,
        patientWeightKg: 64,
        professionalSpecialty: 'Cirugía oral',
        clinicalRecordNumber: 'RX-A-30',
        patientDocument: 'Documento nacional RX-A-30',
      });
      expect(rx).not.toHaveProperty('singleFormat');

      const row = await raw.prescription.findUniqueOrThrow({
        where: { id: rx.id },
      });
      expect(row).toMatchObject({
        singleFormat: true,
        printQuantityInWords: true,
        patientAgeYears: 30,
        patientWeightKg: 64,
        professionalSpecialty: 'Cirugía oral',
      });
      const v3 = await hashOfStoredRow(rx.id);
      expect(v3.computed).toBe(v3.stored);
      const asLegacy = await hashOfStoredRow(rx.id, { singleFormat: false });
      expect(asLegacy.computed).not.toBe(v3.stored);

      const doc = await as(clinicA, dentistA.token, siteA)
        .get(`/prescriptions/${rx.id}`)
        .expect(200);
      expect(doc.body).toMatchObject({
        country: null,
        integrityOk: true,
        patientAgeYears: 30,
        professionalSpecialty: 'Cirugía oral',
      });
    });

    it('weight 72.55 is stored and hashed as 72.5, and integrityOk is true after reading it back', async () => {
      const wera = await createPatient(clinicA, 'Wera', 'RX-A-31');
      await as(clinicA, dentistA.token)
        .put(`/patients/${wera}/medical-history`, {
          vitalSigns: { peso: 72.55 },
        })
        .expect(200);
      const rx = (await issueAt(siteA, wera).expect(201)).body as RxBody;
      expect(rx.patientWeightKg).toBe(72.5);
      const row = await raw.prescription.findUniqueOrThrow({
        where: { id: rx.id },
      });
      expect(row.patientWeightKg).toBe(72.5);
      const v3 = await hashOfStoredRow(rx.id);
      expect(v3.computed).toBe(v3.stored);
      const doc = await as(clinicA, dentistA.token)
        .get(`/prescriptions/${rx.id}`)
        .expect(200);
      expect(doc.body).toMatchObject({
        patientWeightKg: 72.5,
        integrityOk: true,
      });
    });

    it('a future birth date issues 201 with patientAgeYears null', async () => {
      const nextYear = new Date().getUTCFullYear() + 1;
      const unborn = await createPatient(
        clinicA,
        'Futura',
        'RX-A-32',
        `${nextYear}-01-15`,
      );
      for (const site of [siteA, siteB]) {
        const rx = (await issueAt(site, unborn).expect(201)).body as RxBody;
        expect(rx).toMatchObject({
          patientAgeYears: null,
          patientBirthYear: nextYear,
        });
      }
    });

    it('blank specialty in the profile is stored null', async () => {
      await setSpecialty(dentist2A.userId, '   ');
      const staff = await as(clinicA)
        .get(`/staff/${dentist2A.userId}`)
        .expect(200);
      expect(
        (staff.body as { professionalSpecialty: string | null })
          .professionalSpecialty,
      ).toBeNull();
      const res = await as(clinicA, dentist2A.token, siteA)
        .post(rxPath(patientA), { items: [amoxicilina] })
        .expect(201);
      expect((res.body as RxBody).professionalSpecialty).toBeNull();
      const row = await raw.prescription.findUniqueOrThrow({
        where: { id: (res.body as RxBody).id },
      });
      expect(row.professionalSpecialty).toBeNull();
    });

    it('license and specialty come from the member profile; the body license only fills an empty profile', async () => {
      await setSpecialty(dentistA.userId, 'Endodoncia');
      const fromProfile = await issueAt(siteB, patientA, {
        professionalLicense: 'OTRO-1',
        professionalSpecialty: 'Falsa',
      }).expect(201);
      expect(fromProfile.body).toMatchObject({
        professionalLicense: 'RM-12345',
        professionalSpecialty: 'Endodoncia',
      });

      const fresh = await member(
        clinicA,
        ClinicRole.DENTIST,
        'Dr. Nuevo',
        'dentist3',
      );
      const filled = await as(clinicA, fresh.token, siteA)
        .post(rxPath(patientA), {
          items: [amoxicilina],
          professionalLicense: ' TP-77 ',
          professionalSpecialty: 'Falsa',
        })
        .expect(201);
      expect(filled.body).toMatchObject({
        professionalLicense: 'TP-77',
        professionalSpecialty: null,
      });
      const profile = await raw.clinicMembership.findFirstOrThrow({
        where: { tenantId: clinicA.tenantId, userId: fresh.userId },
      });
      expect(profile).toMatchObject({
        professionalLicense: 'TP-77',
        professionalSpecialty: null,
      });
    });

    it('changing the member specialty does not change an issued prescription', async () => {
      await setSpecialty(dentistA.userId, 'Periodoncia');
      const rx = (await issueAt(siteA, patientA).expect(201)).body as RxBody;
      await setSpecialty(dentistA.userId, 'Ortodoncia');
      const doc = await as(clinicA, dentistA.token)
        .get(`/prescriptions/${rx.id}`)
        .expect(200);
      expect(doc.body).toMatchObject({
        professionalSpecialty: 'Periodoncia',
        integrityOk: true,
      });
    });

    it('changing the clinic settings does not change an issued prescription', async () => {
      await setRxSettings(clinicA.tenantId, SETTINGS_ON);
      const on = (await issueAt(siteB, patientA).expect(201)).body as RxBody;
      await setRxSettings(clinicA.tenantId, {
        words: false,
        hc: false,
        days: 30,
      });
      const off = (await issueAt(siteB, patientA).expect(201)).body as RxBody;

      await setRxSettings(clinicA.tenantId, {
        words: false,
        hc: false,
        days: 7,
      });
      const onDoc = await as(clinicA, dentistA.token)
        .get(`/prescriptions/${on.id}`)
        .expect(200);
      expect(onDoc.body).toMatchObject({
        clinicalRecordNumber: 'RX-A-1',
        validUntil: on.validUntil,
        integrityOk: true,
      });
      expect((onDoc.body as RxBody).items[0].quantityInWords).toBe('veintiuno');

      await setRxSettings(clinicA.tenantId, {
        words: true,
        hc: true,
        days: 365,
      });
      const offDoc = await as(clinicA, dentistA.token)
        .get(`/prescriptions/${off.id}`)
        .expect(200);
      expect(offDoc.body).toMatchObject({
        clinicalRecordNumber: null,
        validUntil: off.validUntil,
        integrityOk: true,
      });
      expect((offDoc.body as RxBody).items[0].quantityInWords).toBeNull();
    });

    it('legacy row inserted the old way during the rollout validates with v2', async () => {
      const id = await insertLegacyRow(siteA, {
        country: 'CO',
        patientDocument: 'CC RX-A-1',
        patientBirthYear: null,
        clinicalRecordNumber: 'RX-A-1',
        professionalLicense: 'RM-12345',
        safetyRulesVersion: 'RX_SAFETY_V1',
        safetyAlerts: [],
        packages: null,
      });
      const doc = await as(clinicA, dentistA.token)
        .get(`/prescriptions/${id}`)
        .expect(200);
      const body = doc.body as RxBody;
      expect(body).toMatchObject({
        country: 'CO',
        integrityOk: true,
        clinicalRecordNumber: 'RX-A-1',
        patientDocument: 'CC RX-A-1',
        patientAgeYears: null,
        patientWeightKg: null,
        professionalSpecialty: null,
      });
      expect(body.items[0].quantityInWords).toBe('veintiuno');
      const row = await raw.prescription.findUniqueOrThrow({ where: { id } });
      expect(row.singleFormat).toBe(false);
    });

    it('a new prescription prints «ID local RX…» and a TAX_ID one «Identificación fiscal RX…»', async () => {
      const labelled = await createPatient(
        clinicA,
        'Lia',
        'RX-A-40',
        undefined,
        { docTypeLabel: 'ID local' },
      );
      const fiscal = await createPatient(clinicA, 'Tea', 'RX-A-41', undefined, {
        docType: 'TAX_ID',
      });
      const one = (await issueAt(siteA, labelled).expect(201)).body as RxBody;
      expect(one.patientDocument).toBe('ID local RX-A-40');
      const two = (await issueAt(siteA, fiscal).expect(201)).body as RxBody;
      expect(two.patientDocument).toBe('Identificación fiscal RX-A-41');
      for (const rx of [one, two]) {
        const doc = await as(clinicA, dentistA.token)
          .get(`/prescriptions/${rx.id}`)
          .expect(200);
        expect(doc.body).toMatchObject({
          patientDocument: rx.patientDocument,
          integrityOk: true,
        });
      }
    });

    it('legacy prescription keeps its frozen «CC …» document and integrity', async () => {
      const id = await insertLegacyRow(siteA, {
        country: 'CO',
        patientDocument: 'CC RX-L-1',
        patientBirthYear: null,
        clinicalRecordNumber: 'RX-L-1',
        professionalLicense: 'RM-12345',
        safetyRulesVersion: 'RX_SAFETY_V1',
        safetyAlerts: [],
        packages: null,
      });
      // Ni un nombre local nuevo ni la etiqueta del paciente la tocan.
      await raw.tenant.update({
        where: { id: clinicA.tenantId },
        data: { docTypeNameNationalId: 'Documento A' },
      });
      try {
        const doc = await as(clinicA, dentistA.token)
          .get(`/prescriptions/${id}`)
          .expect(200);
        expect(doc.body).toMatchObject({
          patientDocument: 'CC RX-L-1',
          integrityOk: true,
        });
        const row = await raw.prescription.findUniqueOrThrow({
          where: { id },
        });
        expect(row.patientDocument).toBe('CC RX-L-1');
      } finally {
        await raw.tenant.update({
          where: { id: clinicA.tenantId },
          data: { docTypeNameNationalId: null },
        });
      }
    });

    it('legacy ES-format row inserted the old way renders its issued fields with v1', async () => {
      const id = await insertLegacyRow(siteB, {
        country: 'ES',
        patientDocument: '12345678Z',
        patientBirthYear: 1980,
        clinicalRecordNumber: '12345678Z',
        professionalLicense: '28/012345',
        safetyRulesVersion: null,
        safetyAlerts: null,
        packages: 2,
      });
      const doc = await as(clinicA, dentistA.token)
        .get(`/prescriptions/${id}`)
        .expect(200);
      const body = doc.body as RxBody;
      expect(body).toMatchObject({
        country: 'ES',
        integrityOk: true,
        patientDocument: '12345678Z',
        patientBirthYear: 1980,
        professionalLicense: '28/012345',
      });
      expect(body.items[0]).toMatchObject({
        quantityInWords: 'veintiuno',
        packages: 2,
      });
    });

    it('a location without locale or zone returns nulls, never a 409', async () => {
      const bare = await createSite(
        REGIONAL_NEW_YORK_FIXTURE,
        'Sede sin formato',
      );
      const rx = (await issueAt(bare, patientA).expect(201)).body as RxBody;
      await raw.$executeRaw`
        UPDATE "locations" SET "locale" = NULL, "hourCycle" = NULL
         WHERE "id" = ${bare}::uuid`;
      const doc = await as(clinicA, dentistA.token)
        .get(`/prescriptions/${rx.id}`)
        .expect(200);
      expect((doc.body as RxBody).locationFormat).toEqual({
        timeZone: 'America/New_York',
        locale: null,
        hourCycle: null,
      });

      // Y sin zona (sede a medio configurar): tampoco 409, todo `null`.
      await raw.$executeRaw`
        UPDATE "locations" SET "timeZone" = NULL WHERE "id" = ${bare}::uuid`;
      const noZone = await as(clinicA, dentistA.token)
        .get(`/prescriptions/${rx.id}`)
        .expect(200);
      expect(noZone.body).toMatchObject({
        integrityOk: true,
        locationFormat: { timeZone: null, locale: null, hourCycle: null },
      });
    });

    it('GET /prescriptions/:id returns the current locationFormat of its own location, also when retired', async () => {
      const rx = (await issueAt(siteB, patientA).expect(201)).body as RxBody;
      const read = async () =>
        (
          (
            await as(clinicA, dentistA.token, siteA)
              .get(`/prescriptions/${rx.id}`)
              .expect(200)
          ).body as RxBody
        ).locationFormat;
      expect(await read()).toEqual({
        timeZone: 'Asia/Tokyo',
        locale: 'ja-JP',
        hourCycle: 'h23',
      });
      await raw.$executeRaw`
        UPDATE "locations" SET "locale" = 'de-DE', "hourCycle" = 'h12'
         WHERE "id" = ${siteB}::uuid`;
      expect(await read()).toEqual({
        timeZone: 'Asia/Tokyo',
        locale: 'de-DE',
        hourCycle: 'h12',
      });
      await raw.$executeRaw`
        UPDATE "locations" SET "deletedAt" = now() WHERE "id" = ${siteB}::uuid`;
      expect(await read()).toEqual({
        timeZone: 'Asia/Tokyo',
        locale: 'de-DE',
        hourCycle: 'h12',
      });
    });

    it('una sede de otra clínica en X-Location-Id se rechaza', async () => {
      await as(clinicA, dentistA.token, locationB)
        .post(rxPath(patientA), { items: [amoxicilina] })
        .expect(400);
    });

    /**
     * Una fila como la escribía la API anterior a la receta única: sin
     * `singleFormat` ni ninguna columna nueva, con su país y su hash legado.
     */
    async function insertLegacyRow(
      locationId: string,
      legacy: Pick<
        LegacyPrescriptionHashInput,
        | 'country'
        | 'patientDocument'
        | 'patientBirthYear'
        | 'clinicalRecordNumber'
        | 'professionalLicense'
        | 'safetyRulesVersion'
        | 'safetyAlerts'
      > & { packages: number | null },
    ): Promise<string> {
      const id = randomUUID();
      const { packages, ...fields } = legacy;
      const content: LegacyPrescriptionHashInput = {
        ...fields,
        issuedAt: new Date('2026-10-16T15:00:00.000Z'),
        dispensationDate: '2026-10-16',
        validUntil: '2026-11-14',
        patientId: patientA,
        patientName: 'Ana Receta',
        professionalId: dentistA.userId,
        professionalName: 'Dra. Laura Ruiz',
        professionalEmail: null,
        clinicName: 'Clinica rx-a',
        locationName: 'Sede',
        locationAddress: null,
        notes: null,
        allergyOverride: false,
        allergyMatches: [],
        safetyOverrideReason: null,
        items: [
          {
            ...amoxicilina,
            position: 1,
            brandName: null,
            quantityInWords: 'veintiuno',
            packages,
            instructions: null,
          },
        ],
      };
      const [item] = content.items;
      const alerts =
        content.safetyAlerts === null
          ? null
          : JSON.stringify(content.safetyAlerts);
      await raw.$transaction([
        raw.$executeRaw`
          INSERT INTO "prescriptions" ("id", "tenantId", "locationId", "patientId",
            "professionalId", "country", "issuedAt", "dispensationDate", "validUntil",
            "patientName", "patientDocument", "patientBirthYear", "clinicalRecordNumber",
            "professionalName", "professionalLicense", "professionalEmail", "clinicName",
            "locationName", "locationAddress", "notes", "allergyOverride", "allergyMatches",
            "safetyRulesVersion", "safetyAlerts", "safetyOverrideReason", "contentHash")
          VALUES (${id}::uuid, ${clinicA.tenantId}::uuid, ${locationId}::uuid,
            ${content.patientId}::uuid, ${content.professionalId}::uuid,
            ${content.country}::"ClinicCountry", ${content.issuedAt},
            ${content.dispensationDate}::date, ${content.validUntil}::date,
            ${content.patientName}, ${content.patientDocument}, ${content.patientBirthYear},
            ${content.clinicalRecordNumber}, ${content.professionalName},
            ${content.professionalLicense}, ${content.professionalEmail},
            ${content.clinicName}, ${content.locationName}, ${content.locationAddress},
            ${content.notes}, ${content.allergyOverride}, '[]'::jsonb,
            ${content.safetyRulesVersion}, ${alerts}::jsonb,
            ${content.safetyOverrideReason}, ${computePrescriptionHash(content)})`,
        raw.$executeRaw`
          INSERT INTO "prescription_items" ("id", "tenantId", "prescriptionId",
            "position", "activeIngredient", "brandName", "concentration",
            "pharmaceuticalForm", "route", "dose", "frequency", "durationDays",
            "totalQuantity", "quantityUnit", "quantityInWords", "packages", "instructions")
          VALUES (gen_random_uuid(), ${clinicA.tenantId}::uuid, ${id}::uuid,
            ${item.position}, ${item.activeIngredient}, ${item.brandName},
            ${item.concentration}, ${item.pharmaceuticalForm}, ${item.route},
            ${item.dose}, ${item.frequency}, ${item.durationDays},
            ${item.totalQuantity}, ${item.quantityUnit}, ${item.quantityInWords},
            ${item.packages}, ${item.instructions})`,
      ]);
      return id;
    }
  });

  describe('anular', () => {
    it('motivo obligatorio (400); asistente y otro odontólogo 403', async () => {
      await as(clinicA, dentistA.token)
        .post(`/prescriptions/${rxId}/void`, {})
        .expect(400);
      await as(clinicA, dentistA.token)
        .post(`/prescriptions/${rxId}/void`, { reason: '   ' })
        .expect(400);
      await as(clinicA, assistantA)
        .post(`/prescriptions/${rxId}/void`, { reason: 'x' })
        .expect(403);
      await as(clinicA, dentist2A.token)
        .post(`/prescriptions/${rxId}/void`, { reason: 'No es mía' })
        .expect(403);
    });

    it('quien la emitió la anula: motivo, autor y fecha; después 409', async () => {
      const res = await as(clinicA, dentistA.token)
        .post(`/prescriptions/${rxId}/void`, { reason: ' Dosis equivocada ' })
        .expect(200);
      expect(res.body).toMatchObject({
        status: 'VOIDED',
        voidReason: 'Dosis equivocada',
        voidedById: dentistA.userId,
        voidedByName: 'Dra. Laura Ruiz',
      });
      await as(clinicA, dentistA.token)
        .post(`/prescriptions/${rxId}/void`, { reason: 'Otra' })
        .expect(409);
      const doc = await as(clinicA, dentistA.token)
        .get(`/prescriptions/${rxId}`)
        .expect(200);
      expect(doc.body).toMatchObject({ status: 'VOIDED', integrityOk: true });
      const list = await as(clinicA, dentistA.token)
        .get(rxPath(patientA))
        .expect(200);
      expect((list.body as RxBody[]).find((r) => r.id === rxId)?.status).toBe(
        'VOIDED',
      );
    });

    it('no hay ruta para editar ni borrar una receta', async () => {
      await as(clinicA, dentistA.token)
        .patch(`/prescriptions/${rxId}`, { notes: 'x' })
        .expect(404);
      await as(clinicA, dentistA.token)
        .put(`/prescriptions/${rxId}`, { notes: 'x' })
        .expect(404);
      await as(clinicA, dentistA.token)
        .delete(`/prescriptions/${rxId}`)
        .expect(404);
    });
  });

  describe('roles', () => {
    it('RECEPTION: 403 en todos los endpoints', async () => {
      await as(clinicA, receptionA).get(rxPath(patientA)).expect(403);
      await as(clinicA, receptionA)
        .post(rxPath(patientA), { items: [amoxicilina] })
        .expect(403);
      await as(clinicA, receptionA).get('/prescriptions/issuer').expect(403);
      await as(clinicA, receptionA).get(`/prescriptions/${rxId}`).expect(403);
      await as(clinicA, receptionA)
        .post(`/prescriptions/${rxId}/void`, { reason: 'x' })
        .expect(403);
      await as(clinicA, receptionA).get('/prescription-templates').expect(403);
    });

    it('ASSISTANT lee pero no emite', async () => {
      await as(clinicA, assistantA).get(rxPath(patientA)).expect(200);
      await as(clinicA, assistantA)
        .post(rxPath(patientA), { items: [amoxicilina] })
        .expect(403);
      await as(clinicA, assistantA).get('/prescriptions/issuer').expect(403);
    });
  });

  describe('aislamiento entre clínicas', () => {
    it('la clínica B recibe 404 sobre el paciente y la receta de A', async () => {
      await as(clinicB).get(rxPath(patientA)).expect(404);
      await as(clinicB)
        .post(rxPath(patientA), {
          items: [amoxicilina],
          professionalLicense: 'RM-B',
        })
        .expect(404);
      await as(clinicB).get(`/prescriptions/${rxId}`).expect(404);
      await as(clinicB)
        .post(`/prescriptions/${rxId}/void`, { reason: 'x' })
        .expect(404);
      const own = await as(clinicB).get(rxPath(patientB)).expect(200);
      expect(own.body).toEqual([]);
    });

    it('paciente o receta inexistentes: 404', async () => {
      const ghost = '00000000-0000-4000-8000-000000000000';
      await as(clinicA, dentistA.token).get(rxPath(ghost)).expect(404);
      await as(clinicA, dentistA.token)
        .get(`/prescriptions/${ghost}`)
        .expect(404);
      await as(clinicA, dentistA.token)
        .get('/prescriptions/no-uuid')
        .expect(400);
    });
  });

  describe('plantillas', () => {
    let templateId: string;

    it('ADMIN crea y edita; DENTIST lee pero no escribe (403)', async () => {
      const created = await as(clinicA)
        .post('/prescription-templates', {
          name: 'Post-exodoncia',
          items: [
            amoxicilina,
            { activeIngredient: 'Ibuprofeno', concentration: '600 mg' },
          ],
        })
        .expect(201);
      templateId = (created.body as { id: string }).id;
      await as(clinicA, dentistA.token)
        .post('/prescription-templates', { name: 'X', items: [amoxicilina] })
        .expect(403);
      await as(clinicA, dentistA.token)
        .patch(`/prescription-templates/${templateId}`, { name: 'Y' })
        .expect(403);
      await as(clinicA, dentistA.token)
        .delete(`/prescription-templates/${templateId}`)
        .expect(403);

      const edited = await as(clinicA)
        .patch(`/prescription-templates/${templateId}`, {
          name: 'Post-exodoncia adulto',
        })
        .expect(200);
      expect((edited.body as { name: string }).name).toBe(
        'Post-exodoncia adulto',
      );

      const list = await as(clinicA, dentistA.token)
        .get('/prescription-templates')
        .expect(200);
      expect(list.body).toEqual([
        expect.objectContaining({
          name: 'Post-exodoncia adulto',
          items: [
            expect.objectContaining({
              activeIngredient: 'Amoxicilina',
              totalQuantity: 21,
            }),
            expect.objectContaining({
              activeIngredient: 'Ibuprofeno',
              route: null,
            }),
          ],
        }),
      ]);
    });

    it('400 en español, 409 con nombre repetido; la clínica B no la ve ni la toca', async () => {
      const bad = await as(clinicA)
        .post('/prescription-templates', {
          name: 'Z',
          items: [{ concentration: '1 mg' }],
        })
        .expect(400);
      expect((bad.body as { message: string }).message).toBe(
        'Medicamento 1: falta el principio activo (DCI)',
      );
      await as(clinicA)
        .post('/prescription-templates', {
          name: 'Post-exodoncia adulto',
          items: [amoxicilina],
        })
        .expect(409);
      const listB = await as(clinicB)
        .get('/prescription-templates')
        .expect(200);
      expect(listB.body).toEqual([]);
      await as(clinicB)
        .patch(`/prescription-templates/${templateId}`, { name: 'Robada' })
        .expect(404);
      await as(clinicB)
        .delete(`/prescription-templates/${templateId}`)
        .expect(404);
    });

    it('DELETE la retira en blando', async () => {
      await as(clinicA)
        .delete(`/prescription-templates/${templateId}`)
        .expect(204);
      const list = await as(clinicA).get('/prescription-templates').expect(200);
      expect(list.body).toEqual([]);
      const row = await raw.prescriptionTemplate.findUniqueOrThrow({
        where: { id: templateId },
      });
      expect(row.deletedAt).not.toBeNull();
    });
  });
});
