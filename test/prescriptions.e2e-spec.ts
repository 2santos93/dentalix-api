import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, DocType, Prisma, PrismaClient, Sex } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { applyBodyLimits } from '../src/config/body-limits';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';

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
  country: 'CO' | 'ES';
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
  clinicalRecordNumber: string | null;
  allergyOverride: boolean;
  allergyMatches: { activeIngredient: string; allergen: string }[];
  contentHash: string;
  voidedAt: string | null;
  voidedById: string | null;
  voidedByName: string | null;
  voidReason: string | null;
  integrityOk?: boolean;
  items: {
    position: number;
    activeIngredient: string;
    quantityInWords: string;
    packages: number | null;
  }[];
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
  let spanishA: string;
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
  ): Promise<string> {
    const res = await as(session)
      .post('/patients', {
        firstName,
        lastName: 'Receta',
        docType: DocType.CC,
        docNumber,
        birthDate,
        sex: Sex.F,
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
    spanishA = await createPatient(clinicA, 'Elena', '12345678Z', '1980-05-04');
    patientB = await createPatient(clinicB, 'Carla', 'RX-B-1');
    locationB = (
      await raw.location.findFirstOrThrow({
        where: { tenantId: clinicB.tenantId },
      })
    ).id;

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

  describe('emitir (CO)', () => {
    it('el emisor: país, sede y registro profesional del usuario', async () => {
      const res = await as(clinicA, dentistA.token)
        .get('/prescriptions/issuer')
        .expect(200);
      expect(res.body).toMatchObject({
        country: 'CO',
        professionalName: 'Dra. Laura Ruiz',
        professionalLicense: 'RM-12345',
        validityDays: 30,
        maxItems: 10,
      });
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
        country: 'CO',
        professionalId: dentistA.userId,
        professionalLicense: 'RM-12345',
        clinicalRecordNumber: 'RX-A-1',
        patientDocument: 'CC RX-A-1',
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
        'Falta tu registro profesional',
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

  describe('España (sede con country=ES)', () => {
    let madrid: string;

    beforeAll(async () => {
      const res = await as(clinicA)
        .post('/locations', {
          name: 'Sede Madrid',
          address: 'Calle Mayor 1, Madrid',
          country: 'ES',
        })
        .expect(201);
      madrid = (res.body as { id: string; country: string }).id;
      expect((res.body as { country: string }).country).toBe('ES');
    });

    it('exige nº de envases, DNI/NIE y año de nacimiento; un medicamento por receta', async () => {
      const ctx = await as(clinicA, dentistA.token, madrid)
        .get('/prescriptions/issuer')
        .expect(200);
      expect(ctx.body).toMatchObject({
        country: 'ES',
        validityDays: 10,
        maxItems: 1,
      });

      const noPackages = await as(clinicA, dentistA.token, madrid)
        .post(rxPath(spanishA), { items: [amoxicilina] })
        .expect(400);
      expect((noPackages.body as { message: string }).message).toContain(
        'falta el número de envases',
      );
      const noDni = await as(clinicA, dentistA.token, madrid)
        .post(rxPath(patientA), { items: [{ ...amoxicilina, packages: 1 }] })
        .expect(400);
      expect((noDni.body as { message: string }).message).toContain(
        'Falta el año de nacimiento del paciente',
      );
      const two = await as(clinicA, dentistA.token, madrid)
        .post(rxPath(spanishA), {
          items: [
            { ...amoxicilina, packages: 1 },
            { ...ibuprofeno, packages: 1 },
          ],
        })
        .expect(400);
      expect((two.body as { message: string }).message).toContain(
        'un solo medicamento',
      );
    });

    it('emite con validez de 10 días desde la fecha prevista de dispensación', async () => {
      const res = await as(clinicA, dentistA.token, madrid)
        .post(rxPath(spanishA), { items: [{ ...amoxicilina, packages: 2 }] })
        .expect(201);
      const rx = res.body as RxBody;
      expect(rx).toMatchObject({
        country: 'ES',
        locationId: madrid,
        locationName: 'Sede Madrid',
        patientDocument: '12345678Z',
        patientBirthYear: 1980,
      });
      expect(rx.items[0].packages).toBe(2);
      const start = new Date(`${rx.dispensationDate}T00:00:00Z`);
      start.setUTCDate(start.getUTCDate() + 9);
      expect(rx.validUntil).toBe(start.toISOString().slice(0, 10));
    });

    it('una sede de otra clínica en X-Location-Id se rechaza', async () => {
      await as(clinicA, dentistA.token, locationB)
        .post(rxPath(patientA), { items: [amoxicilina] })
        .expect(400);
    });
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
