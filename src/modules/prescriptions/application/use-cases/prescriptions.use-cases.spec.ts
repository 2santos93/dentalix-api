import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicCountry, ClinicRole, PrescriptionStatus } from '@prisma/client';
import {
  DENTIST_ID,
  InMemoryPrescriptionRepository,
  makeIssuer,
  makePatient,
  OTHER_DENTIST_ID,
  PATIENT_ID,
} from '../__fixtures__/in-memory-prescriptions';
import {
  GetPrescriptionIssuerUseCase,
  GetPrescriptionUseCase,
  IssuePrescriptionUseCase,
  ListPatientPrescriptionsUseCase,
  CheckPrescriptionSafetyUseCase,
  VoidPrescriptionUseCase,
  type IssuePrescriptionInput,
} from './prescriptions.use-cases';
import { computePrescriptionHash } from '../../domain/prescription-hash';
import {
  emptySafetyAnamnesis,
  PRESCRIPTION_SAFETY_RULES_VERSION,
  type SafetyAnamnesis,
} from '../../domain/prescription-safety';

// 15:00 UTC = 10:00 en Bogotá y 17:00 en Madrid, el mismo día 16.
const NOW = new Date('2026-10-16T15:00:00.000Z');

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

function input(
  extra: Partial<IssuePrescriptionInput> = {},
): IssuePrescriptionInput {
  return { items: [amoxicilina], ...extra };
}

describe('IssuePrescriptionUseCase', () => {
  let repo: InMemoryPrescriptionRepository;
  let useCase: IssuePrescriptionUseCase;

  beforeEach(() => {
    repo = new InMemoryPrescriptionRepository();
    useCase = new IssuePrescriptionUseCase(repo, () => NOW);
  });

  it('emite una receta CO con la foto de los datos legales, cantidad en letras y hash', async () => {
    const rx = await useCase.execute(
      PATIENT_ID,
      input({ notes: ' Tomar con comida ' }),
      DENTIST_ID,
    );

    expect(rx).toMatchObject({
      status: PrescriptionStatus.ISSUED,
      country: ClinicCountry.CO,
      patientId: PATIENT_ID,
      professionalId: DENTIST_ID,
      issuedAt: NOW,
      dispensationDate: '2026-10-16',
      validUntil: '2026-11-14',
      patientName: 'Ana Pérez Gómez',
      patientDocument: 'CC 1020304050',
      clinicalRecordNumber: '1020304050',
      professionalName: 'Dra. Laura Ruiz',
      professionalLicense: 'RM-12345',
      clinicName: 'Clínica Demo',
      locationName: 'Sede Principal',
      notes: 'Tomar con comida',
      allergyOverride: false,
      allergyMatches: [],
    });
    expect(rx.items).toEqual([
      expect.objectContaining({
        position: 1,
        activeIngredient: 'Amoxicilina',
        totalQuantity: 21,
        quantityInWords: 'veintiuno',
        packages: null,
        brandName: null,
      }),
    ]);
    expect(rx.contentHash).toBe(
      computePrescriptionHash({
        ...rx,
        items: rx.items.map(({ id: _id, ...item }) => item),
      }),
    );
    expect(repo.savedLicenses).toEqual([]);
  });

  it('404 si el paciente no es de esta clínica', async () => {
    await expect(
      useCase.execute(
        '00000000-0000-4000-8000-0000000000ff',
        input(),
        DENTIST_ID,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('400 en español con TODOS los campos que faltan', async () => {
    const promise = useCase.execute(
      PATIENT_ID,
      input({ items: [{ ...amoxicilina, dose: '', route: ' ' }] }),
      DENTIST_ID,
    );
    await expect(promise).rejects.toBeInstanceOf(BadRequestException);
    await expect(promise).rejects.toThrow(
      'No se puede emitir la receta: Medicamento 1: falta la vía de administración; Medicamento 1: falta la dosis.',
    );
    expect(repo.rows).toEqual([]);
  });

  it('sin registro profesional guardado lo toma del cuerpo, lo sella en la receta y lo guarda en la membresía', async () => {
    repo.issuer = makeIssuer({}, null);
    await expect(
      useCase.execute(PATIENT_ID, input(), DENTIST_ID),
    ).rejects.toThrow('Falta tu registro profesional');
    const rx = await useCase.execute(
      PATIENT_ID,
      input({ professionalLicense: ' TP-998877 ' }),
      DENTIST_ID,
    );
    expect(rx.professionalLicense).toBe('TP-998877');
    expect(repo.savedLicenses).toEqual([
      { userId: DENTIST_ID, license: 'TP-998877' },
    ]);
  });

  it('con registro ya guardado (lo gestiona ADMIN) ignora el del cuerpo: ni lo sella ni pisa el perfil', async () => {
    const rx = await useCase.execute(
      PATIENT_ID,
      input({ professionalLicense: 'FALSO-999' }),
      DENTIST_ID,
    );
    expect(rx.professionalLicense).toBe('RM-12345');
    expect(repo.savedLicenses).toEqual([]);
  });

  describe('receta segura (DX-300)', () => {
    const ibuprofeno = {
      ...amoxicilina,
      activeIngredient: 'Ibuprofeno',
      concentration: '400 mg',
      dose: '1 comprimido',
      quantityUnit: 'comprimidos',
    };
    const withAnamnesis = (
      overrides: Partial<Omit<SafetyAnamnesis, 'flags'>> & {
        flags?: Partial<SafetyAnamnesis['flags']>;
      },
    ) => {
      const base = emptySafetyAnamnesis();
      repo.patients.set(
        PATIENT_ID,
        makePatient({
          anamnesis: {
            ...base,
            ...overrides,
            flags: { ...base.flags, ...overrides.flags },
          },
        }),
      );
    };
    const conflict = async (promise: Promise<unknown>) => {
      await expect(promise).rejects.toBeInstanceOf(ConflictException);
      const error = (await promise.catch(
        (e: unknown) => e,
      )) as ConflictException;
      return error.getResponse() as Record<string, unknown>;
    };

    it('casilla «Alergia a penicilina» con la lista vacía: amoxicilina da 409 con el aviso y no guarda nada', async () => {
      withAnamnesis({ flags: { alergiaPenicilina: true } });
      const body = await conflict(
        useCase.execute(PATIENT_ID, input(), DENTIST_ID),
      );
      expect(body).toMatchObject({
        statusCode: 409,
        message: expect.stringContaining(
          'Avisos de seguridad sin confirmar',
        ) as string,
        allergyMatches: [
          { activeIngredient: 'Amoxicilina', allergen: 'penicilina' },
        ],
        safetyAlerts: [
          expect.objectContaining({
            code: 'ALLERGY_MATCH',
            severity: 'BLOCKING',
          }),
        ],
      });
      expect(repo.rows).toEqual([]);
    });

    it('confirmación sin motivo (o en blanco): 409 que pide el motivo', async () => {
      withAnamnesis({ allergens: ['Penicilina'] });
      for (const reason of [undefined, '   ']) {
        const body = await conflict(
          useCase.execute(
            PATIENT_ID,
            input({ safetyOverride: true, safetyOverrideReason: reason }),
            DENTIST_ID,
          ),
        );
        expect(body.message).toContain('Escribe el motivo');
      }
      expect(repo.rows).toEqual([]);
    });

    it('warfarina: ibuprofeno solo se emite con confirmación y motivo, que quedan en la receta y en el hash', async () => {
      withAnamnesis({ medications: ['Warfarina 5 mg'] });
      await conflict(
        useCase.execute(PATIENT_ID, input({ items: [ibuprofeno] }), DENTIST_ID),
      );
      const rx = await useCase.execute(
        PATIENT_ID,
        input({
          items: [ibuprofeno],
          safetyOverride: true,
          safetyOverrideReason: '  INR estable; pauta de 2 días  ',
        }),
        DENTIST_ID,
      );
      expect(rx.safetyRulesVersion).toBe(PRESCRIPTION_SAFETY_RULES_VERSION);
      expect(rx.safetyOverrideReason).toBe('INR estable; pauta de 2 días');
      expect(rx.safetyAlerts).toEqual([
        expect.objectContaining({
          code: 'INTERACTION_ANTICOAGULANT_NSAID',
          severity: 'BLOCKING',
        }),
      ]);
      expect(rx.allergyOverride).toBe(false);
      expect(rx.contentHash).toBe(
        computePrescriptionHash({
          ...rx,
          items: rx.items.map(({ id: _id, ...item }) => item),
        }),
      );
    });

    it('allergyOverride (cliente anterior) cuenta como confirmación; el motivo sigue siendo obligatorio', async () => {
      withAnamnesis({ allergens: ['Penicilina', 'Látex'] });
      await conflict(
        useCase.execute(
          PATIENT_ID,
          input({ allergyOverride: true }),
          DENTIST_ID,
        ),
      );
      const rx = await useCase.execute(
        PATIENT_ID,
        input({
          allergyOverride: true,
          safetyOverrideReason: 'Prueba cutánea negativa',
        }),
        DENTIST_ID,
      );
      expect(rx.allergyOverride).toBe(true);
      expect(rx.allergyMatches).toEqual([
        { activeIngredient: 'Amoxicilina', allergen: 'Penicilina' },
      ]);
    });

    it('sin bloqueantes, la confirmación y el motivo no se guardan', async () => {
      const rx = await useCase.execute(
        PATIENT_ID,
        input({
          items: [{ ...amoxicilina, activeIngredient: 'Clorhexidina' }],
          allergyOverride: true,
          safetyOverride: true,
          safetyOverrideReason: 'Por si acaso',
        }),
        DENTIST_ID,
      );
      expect(rx.allergyOverride).toBe(false);
      expect(rx.allergyMatches).toEqual([]);
      expect(rx.safetyAlerts).toEqual([]);
      expect(rx.safetyOverrideReason).toBeNull();
    });

    it('sin anamnesis: se emite y la receta registra el aviso', async () => {
      repo.patients.set(PATIENT_ID, makePatient({ anamnesis: null }));
      const rx = await useCase.execute(PATIENT_ID, input(), DENTIST_ID);
      expect(rx.safetyAlerts).toEqual([
        expect.objectContaining({
          code: 'NO_ANAMNESIS',
          severity: 'INFO',
          message:
            'Sin anamnesis vigente: no se han podido comprobar alergias ni interacciones',
        }),
      ]);
    });

    it('edad por fecha de nacimiento en la zona de la sede: 6 años y 20 kg con amoxicilina 1 g/8 h → 409', async () => {
      repo.patients.set(
        PATIENT_ID,
        makePatient({
          birthDate: new Date('2020-10-16T00:00:00.000Z'),
          anamnesis: { ...emptySafetyAnamnesis(), weightKg: 20 },
        }),
      );
      const body = await conflict(
        useCase.execute(
          PATIENT_ID,
          input({
            items: [{ ...amoxicilina, concentration: '1 g', dose: '1 g' }],
          }),
          DENTIST_ID,
        ),
      );
      expect(body.message).toContain('50 mg/kg/toma');
    });
  });

  describe('previsualizar avisos', () => {
    it('devuelve los avisos que daría la emisión, sin guardar nada', async () => {
      const base = emptySafetyAnamnesis();
      repo.patients.set(
        PATIENT_ID,
        makePatient({
          anamnesis: {
            ...base,
            flags: { ...base.flags, embarazo: true, semanasEmbarazo: 24 },
          },
        }),
      );
      const check = new CheckPrescriptionSafetyUseCase(repo, () => NOW);
      const result = await check.execute(
        PATIENT_ID,
        [
          { activeIngredient: 'Ibuprofeno' },
          { activeIngredient: 'Paracetamol' },
        ],
        DENTIST_ID,
      );
      expect(result).toEqual({
        rulesVersion: PRESCRIPTION_SAFETY_RULES_VERSION,
        anamnesis: 'PRESENT',
        hasBlocking: true,
        alerts: [expect.objectContaining({ code: 'PREGNANCY_NSAID' })],
      });
      expect(repo.rows).toEqual([]);
    });

    it('404 si el paciente no es de esta clínica', async () => {
      const check = new CheckPrescriptionSafetyUseCase(repo, () => NOW);
      await expect(
        check.execute('00000000-0000-4000-8000-0000000000ff', [], DENTIST_ID),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('España', () => {
    beforeEach(() => {
      repo.issuer = makeIssuer(
        { country: ClinicCountry.ES, timeZone: 'Europe/Madrid' },
        '28/012345',
      );
      repo.patients.set(
        PATIENT_ID,
        makePatient({ docType: 'OTHER', docNumber: '12345678Z' }),
      );
    });

    it('validez de 10 días desde la fecha prevista de dispensación y año de nacimiento', async () => {
      const rx = await useCase.execute(
        PATIENT_ID,
        input({
          items: [{ ...amoxicilina, packages: 1 }],
          dispensationDate: '2026-10-20',
        }),
        DENTIST_ID,
      );
      expect(rx).toMatchObject({
        country: ClinicCountry.ES,
        dispensationDate: '2026-10-20',
        validUntil: '2026-10-29',
        patientBirthYear: 1985,
        patientDocument: '12345678Z',
        clinicalRecordNumber: '12345678Z',
      });
      expect(rx.items[0].packages).toBe(1);
    });

    it('exige el nº de envases', async () => {
      await expect(
        useCase.execute(PATIENT_ID, input(), DENTIST_ID),
      ).rejects.toThrow('Medicamento 1: falta el número de envases');
    });
  });

  it.each([
    ['2026-10-15', 'La fecha de dispensación no puede ser anterior a hoy'],
    ['2026-02-31', 'La fecha de dispensación no existe en el calendario'],
    [
      '2027-02-01',
      'La fecha de dispensación no puede ser más de 90 días posterior a hoy',
    ],
  ])('fecha de dispensación %s → 400', async (date, message) => {
    await expect(
      useCase.execute(
        PATIENT_ID,
        input({ dispensationDate: date }),
        DENTIST_ID,
      ),
    ).rejects.toThrow(message);
  });
});

describe('Listar, ver y anular', () => {
  let repo: InMemoryPrescriptionRepository;
  let issue: IssuePrescriptionUseCase;
  let id: string;
  const later = new Date('2026-10-16T16:00:00.000Z');

  beforeEach(async () => {
    repo = new InMemoryPrescriptionRepository();
    issue = new IssuePrescriptionUseCase(repo, () => NOW);
    id = (await issue.execute(PATIENT_ID, input(), DENTIST_ID)).id;
  });

  it('lista las recetas del paciente y da 404 si el paciente no es de la clínica', async () => {
    const list = new ListPatientPrescriptionsUseCase(repo);
    expect((await list.execute(PATIENT_ID)).map((r) => r.id)).toEqual([id]);
    await expect(
      list.execute('00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el documento recalcula el hash: integrityOk', async () => {
    const get = new GetPrescriptionUseCase(repo);
    expect((await get.execute(id)).integrityOk).toBe(true);
    repo.rows[0].items[0].totalQuantity = 99;
    expect((await get.execute(id)).integrityOk).toBe(false);
    await expect(
      get.execute('00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('una receta emitida antes de DX-300 (sin avisos) sigue validando con el hash v1', async () => {
    const legacy = repo.rows[0];
    legacy.safetyRulesVersion = null;
    legacy.safetyAlerts = null;
    legacy.safetyOverrideReason = null;
    legacy.contentHash = computePrescriptionHash({
      ...legacy,
      items: legacy.items.map(({ id: _id, ...item }) => item),
    });
    const doc = await new GetPrescriptionUseCase(repo).execute(id);
    expect(doc.integrityOk).toBe(true);
    expect(doc.safetyAlerts).toBeNull();
  });

  it('anula con motivo, autor y fecha del servidor; la integridad sigue intacta', async () => {
    const voidRx = new VoidPrescriptionUseCase(repo, () => later);
    const voided = await voidRx.execute(id, '  Dosis equivocada  ', {
      userId: DENTIST_ID,
      role: ClinicRole.DENTIST,
    });
    expect(voided).toMatchObject({
      status: PrescriptionStatus.VOIDED,
      voidReason: 'Dosis equivocada',
      voidedById: DENTIST_ID,
      voidedByName: 'Dra. Laura Ruiz',
      voidedAt: later,
    });
    expect(
      (await new GetPrescriptionUseCase(repo).execute(id)).integrityOk,
    ).toBe(true);
  });

  it('motivo vacío 400, inexistente 404, ya anulada 409', async () => {
    const voidRx = new VoidPrescriptionUseCase(repo, () => later);
    const actor = { userId: DENTIST_ID, role: ClinicRole.DENTIST };
    await expect(voidRx.execute(id, '   ', actor)).rejects.toThrow(
      'El motivo de la anulación es obligatorio',
    );
    await expect(
      voidRx.execute('00000000-0000-4000-8000-0000000000ff', 'x', actor),
    ).rejects.toBeInstanceOf(NotFoundException);
    await voidRx.execute(id, 'Error', actor);
    await expect(voidRx.execute(id, 'Otra vez', actor)).rejects.toThrow(
      'La receta ya está anulada',
    );
  });

  it('otro odontólogo no puede anularla (403); un ADMIN sí', async () => {
    const voidRx = new VoidPrescriptionUseCase(repo, () => later);
    await expect(
      voidRx.execute(id, 'No es mía', {
        userId: OTHER_DENTIST_ID,
        role: ClinicRole.DENTIST,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      voidRx.execute(id, 'Corrección', {
        userId: OTHER_DENTIST_ID,
        role: ClinicRole.ADMIN,
      }),
    ).resolves.toMatchObject({ status: PrescriptionStatus.VOIDED });
  });
});

describe('GetPrescriptionIssuerUseCase', () => {
  it('devuelve país, sede, profesional, registro y validez', async () => {
    const repo = new InMemoryPrescriptionRepository();
    repo.issuer = makeIssuer({ country: ClinicCountry.ES }, null);
    await expect(
      new GetPrescriptionIssuerUseCase(repo).execute(DENTIST_ID),
    ).resolves.toEqual({
      country: ClinicCountry.ES,
      locationId: repo.issuer.location.id,
      locationName: 'Sede Principal',
      locationAddress: 'Cra 15 #90-20, Bogotá',
      clinicName: 'Clínica Demo',
      professionalName: 'Dra. Laura Ruiz',
      professionalLicense: null,
      validityDays: 10,
      maxItems: 1,
    });
  });
});
