import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole, PrescriptionStatus } from '@prisma/client';
import {
  DENTIST_ID,
  InMemoryPrescriptionRepository,
  makeIssuer,
  makePatient,
  OTHER_DENTIST_ID,
  PATIENT_ID,
} from '../__fixtures__/in-memory-prescriptions';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import {
  GetPrescriptionIssuerUseCase,
  GetPrescriptionUseCase,
  IssuePrescriptionUseCase,
  ListPatientPrescriptionsUseCase,
  CheckPrescriptionSafetyUseCase,
  VoidPrescriptionUseCase,
  type IssuePrescriptionInput,
} from './prescriptions.use-cases';
import {
  computePrescriptionHash,
  expectedPrescriptionHash,
  type PrescriptionHashInput,
} from '../../domain/prescription-hash';
import {
  emptySafetyAnamnesis,
  PRESCRIPTION_SAFETY_RULES_VERSION,
  type SafetyAnamnesis,
} from '../../domain/prescription-safety';

// DX-327: los nombres locales de la clínica; cada test empieza sin ninguno.
let names: FixedDocumentTypeNamesReader;
beforeEach(() => {
  names = new FixedDocumentTypeNamesReader();
});

// 15:00 UTC = 11:00 en la zona de la sede de los tests (Nueva York), el mismo día 16.
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
    useCase = new IssuePrescriptionUseCase(repo, () => NOW, names);
  });

  it('emite la receta única con la foto de los datos, cantidad en letras y hash', async () => {
    const rx = await useCase.execute(
      PATIENT_ID,
      input({ notes: ' Tomar con comida ' }),
      DENTIST_ID,
    );

    expect(rx).toMatchObject({
      status: PrescriptionStatus.ISSUED,
      singleFormat: true,
      patientId: PATIENT_ID,
      professionalId: DENTIST_ID,
      issuedAt: NOW,
      dispensationDate: '2026-10-16',
      validUntil: '2026-11-14',
      patientName: 'Ana Pérez Gómez',
      patientDocument: 'Documento nacional 1020304050',
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
    expect(rx.contentHash).toBe(expectedPrescriptionHash(rx));
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
    ).rejects.toThrow('Falta tu número de registro profesional');
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
      expect(rx.contentHash).toBe(expectedPrescriptionHash(rx));
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
    issue = new IssuePrescriptionUseCase(repo, () => NOW, names);
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

  it('legacy: una receta emitida antes de DX-300 (sin avisos) sigue validando con el hash v1', async () => {
    const legacy = repo.rows[0];
    legacy.singleFormat = false;
    legacy.printQuantityInWords = null;
    legacy.professionalSpecialty = null;
    legacy.patientAgeYears = null;
    legacy.patientWeightKg = null;
    legacy.safetyRulesVersion = null;
    legacy.safetyAlerts = null;
    legacy.safetyOverrideReason = null;
    const { country } = legacy;
    if (country === null) throw new Error('la receta legada lleva país');
    legacy.contentHash = computePrescriptionHash({
      ...legacy,
      country,
      singleFormat: false,
      items: legacy.items.map(({ id: _id, ...item }) => item),
    });
    const doc = await new GetPrescriptionUseCase(repo).execute(id);
    expect(doc.integrityOk).toBe(true);
    expect(doc.safetyAlerts).toBeNull();
  });

  it('legacy: a row that cannot be sealed with its format reads integrityOk false, never a 500', async () => {
    const get = new GetPrescriptionUseCase(repo);
    const row = repo.rows[0];
    const sealed = structuredClone(row);

    // Única sin el booleano de las letras (lo impide el CHECK de la tabla).
    row.printQuantityInWords = null;
    await expect(get.execute(id)).resolves.toMatchObject({
      integrityOk: false,
    });

    // Legada sin país (lo impide el CHECK prescriptions_legacy_country_present_check).
    Object.assign(row, sealed, { singleFormat: false, country: null });
    await expect(get.execute(id)).resolves.toMatchObject({
      integrityOk: false,
    });
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
  it('issuer view carries the clinic settings, the specialty and the phase-1 block untouched; no country of its own', async () => {
    const repo = new InMemoryPrescriptionRepository();
    repo.issuer = makeIssuer({}, null, {
      settings: {
        printQuantityInWords: false,
        requireClinicalRecordNumber: true,
        validityDays: 7,
      },
      specialty: 'Cirugía oral',
    });
    const view = await new GetPrescriptionIssuerUseCase(repo).execute(
      DENTIST_ID,
    );
    expect(view).toEqual({
      locationId: repo.issuer.location.id,
      locationName: 'Sede Principal',
      locationAddress: 'Avenida Central 100',
      clinicName: 'Clínica Demo',
      professionalName: 'Dra. Laura Ruiz',
      professionalLicense: null,
      professionalSpecialty: 'Cirugía oral',
      validityDays: 7,
      maxItems: 10,
      printQuantityInWords: false,
      requireClinicalRecordNumber: true,
      phase1: { country: 'CO' },
    });
    expect(view.phase1).toBe(repo.issuer.phase1);
    expect('country' in view).toBe(false);
  });
});

describe('receta única (DX-324)', () => {
  let repo: InMemoryPrescriptionRepository;

  const issueAt = (now: Date, extra: Partial<IssuePrescriptionInput> = {}) =>
    new IssuePrescriptionUseCase(repo, () => now, names).execute(
      PATIENT_ID,
      input(extra),
      DENTIST_ID,
    );
  const issue = (extra: Partial<IssuePrescriptionInput> = {}) =>
    issueAt(NOW, extra);
  const created = () => {
    if (repo.lastCreateInput === null) throw new Error('nada insertado');
    return repo.lastCreateInput;
  };
  const setSettings = (
    settings: Partial<typeof repo.issuer.settings>,
  ): void => {
    repo.issuer = {
      ...repo.issuer,
      settings: { ...repo.issuer.settings, ...settings },
    };
  };

  beforeEach(() => {
    repo = new InMemoryPrescriptionRepository();
  });

  it('issued snapshot has no country key, singleFormat true and a v3 hash', async () => {
    await issue();
    const content = created();
    expect('country' in content).toBe(false);
    expect(content.singleFormat).toBe(true);
    const { contentHash, locationId: _l, ...sealed } = content;
    // La v3 no sella el país: el que copie el repositorio no cambia el hash.
    const asCo: PrescriptionHashInput = { ...sealed, country: 'CO' };
    const asEs: PrescriptionHashInput = { ...sealed, country: 'ES' };
    expect(contentHash).toBe(computePrescriptionHash(sealed));
    expect(computePrescriptionHash(asCo)).toBe(contentHash);
    expect(computePrescriptionHash(asEs)).toBe(contentHash);
    expect(
      computePrescriptionHash({
        ...sealed,
        country: 'CO',
        singleFormat: false,
      }),
    ).not.toBe(contentHash);
    const doc = await new GetPrescriptionUseCase(repo).execute(repo.rows[0].id);
    expect(doc.integrityOk).toBe(true);
  });

  it('words are always written; printQuantityInWords freezes the setting', async () => {
    setSettings({ printQuantityInWords: false });
    const off = await issue();
    expect(created().printQuantityInWords).toBe(false);
    expect(created().items[0].quantityInWords).toBe('veintiuno');

    setSettings({ printQuantityInWords: true });
    await issue();
    expect(created().printQuantityInWords).toBe(true);
    expect(created().items[0].quantityInWords).toBe('veintiuno');

    // Encender el ajuste después no cambia la receta ya emitida.
    const doc = await new GetPrescriptionUseCase(repo).execute(off.id);
    expect(doc.printQuantityInWords).toBe(false);
    expect(doc.integrityOk).toBe(true);
  });

  it('HC on copies docNumber to clinicalRecordNumber; HC off leaves it null even with a document', async () => {
    setSettings({ requireClinicalRecordNumber: true });
    expect((await issue()).clinicalRecordNumber).toBe('1020304050');

    setSettings({ requireClinicalRecordNumber: false });
    const off = await issue();
    expect(off.clinicalRecordNumber).toBeNull();
    expect(off.patientDocument).toBe('Documento nacional 1020304050');

    repo.patients.set(PATIENT_ID, makePatient({ docNumber: null }));
    expect((await issue()).patientDocument).toBeNull();
    setSettings({ requireClinicalRecordNumber: true });
    await expect(issue()).rejects.toThrow(
      'Falta el número de historia clínica: registra el documento del paciente en sus datos',
    );
  });

  it('validUntil uses the clinic validityDays (7 → start + 6)', async () => {
    setSettings({ validityDays: 7 });
    const rx = await issue({ dispensationDate: '2026-10-20' });
    expect(rx.validUntil).toBe('2026-10-26');
    setSettings({ validityDays: 1 });
    expect((await issue()).validUntil).toBe('2026-10-16');
  });

  it('patientDocument is «{label} {number}» for every clinic and null without a number', async () => {
    repo.patients.set(
      PATIENT_ID,
      makePatient({ docType: 'PASSPORT', docNumber: 'X1' }),
    );
    expect((await issue()).patientDocument).toBe('Pasaporte X1');
    repo.patients.set(PATIENT_ID, makePatient({ docNumber: null }));
    setSettings({ requireClinicalRecordNumber: false });
    expect((await issue()).patientDocument).toBeNull();
  });

  it('a new prescription freezes the display name: patient label, clinic name or generic', async () => {
    names.names.NATIONAL_ID = 'Documento A';
    repo.patients.set(
      PATIENT_ID,
      makePatient({ docTypeLabel: 'ID local', docNumber: 'RX-1' }),
    );
    const labelled = await issue();
    expect(labelled.patientDocument).toBe('ID local RX-1');
    expect(labelled.contentHash).toBe(expectedPrescriptionHash(labelled));

    repo.patients.set(PATIENT_ID, makePatient({ docNumber: 'RX-2' }));
    expect((await issue()).patientDocument).toBe('Documento A RX-2');

    names.names.NATIONAL_ID = null;
    repo.patients.set(
      PATIENT_ID,
      makePatient({ docType: 'TAX_ID', docNumber: 'RX-3' }),
    );
    const generic = await issue();
    expect(generic.patientDocument).toBe('Identificación fiscal RX-3');

    // Lo emitido es texto: cambiar el nombre local después no lo toca.
    names.names.TAX_ID = 'Documento B';
    const doc = await new GetPrescriptionUseCase(repo).execute(generic.id);
    expect(doc.patientDocument).toBe('Identificación fiscal RX-3');
    expect(doc.integrityOk).toBe(true);
    // Una lectura de los nombres por emisión.
    expect(names.reads).toBe(3);
  });

  it('age is computed on the location day', async () => {
    repo.issuer = makeIssuer({ timeZone: 'America/New_York' });
    repo.patients.set(
      PATIENT_ID,
      makePatient({ birthDate: new Date('2000-05-04T00:00:00.000Z') }),
    );
    // 02:00 UTC del 4 de mayo aún es el día 3 en la sede: 26, no 27.
    const rx = await issueAt(new Date('2027-05-04T02:00:00.000Z'));
    expect(rx.patientAgeYears).toBe(26);
    expect(rx.dispensationDate).toBe('2027-05-03');
  });

  it('an impossible age snapshots null and still issues', async () => {
    for (const birth of ['2030-01-01', '1850-01-01']) {
      repo.patients.set(
        PATIENT_ID,
        makePatient({ birthDate: new Date(`${birth}T00:00:00.000Z`) }),
      );
      const rx = await issue();
      expect({ birth, age: rx.patientAgeYears }).toEqual({ birth, age: null });
      expect(rx.patientBirthYear).toBe(Number(birth.slice(0, 4)));
    }
    repo.patients.set(PATIENT_ID, makePatient({ birthDate: null }));
    expect((await issue()).patientAgeYears).toBeNull();
  });

  it('weight 72.55 from the anamnesis is snapshotted as 72.5; 399.96 → null; no anamnesis → null', async () => {
    const withWeight = (weightKg: number | null) =>
      repo.patients.set(
        PATIENT_ID,
        makePatient({ anamnesis: { ...emptySafetyAnamnesis(), weightKg } }),
      );
    withWeight(72.55);
    const rx = await issue();
    expect(rx.patientWeightKg).toBe(72.5);
    expect(rx.contentHash).toBe(
      computePrescriptionHash({ ...created(), patientWeightKg: 72.5 }),
    );
    withWeight(399.96);
    expect((await issue()).patientWeightKg).toBeNull();
    withWeight(null);
    expect((await issue()).patientWeightKg).toBeNull();
    repo.patients.set(PATIENT_ID, makePatient({ anamnesis: null }));
    expect((await issue()).patientWeightKg).toBeNull();
  });

  it('body license fills only an empty profile; specialty only from the profile', async () => {
    repo.issuer = makeIssuer({}, null, { specialty: '  Endodoncia ' });
    const body = {
      professionalLicense: ' RP-7 ',
      professionalSpecialty: 'Falsa',
    } as Partial<IssuePrescriptionInput>;
    const filled = await issue(body);
    expect(filled.professionalLicense).toBe('RP-7');
    expect(filled.professionalSpecialty).toBe('Endodoncia');
    expect(repo.savedLicenses).toEqual([
      { userId: DENTIST_ID, license: 'RP-7' },
    ]);

    repo.issuer = makeIssuer({}, 'RM-12345', { specialty: null });
    const kept = await issue(body);
    expect(kept.professionalLicense).toBe('RM-12345');
    expect(kept.professionalSpecialty).toBeNull();
    expect(repo.savedLicenses).toHaveLength(1);
  });

  it('a five-item prescription with no packages and no birth date issues', async () => {
    repo.patients.set(PATIENT_ID, makePatient({ birthDate: null }));
    const rx = await issue({
      items: Array.from({ length: 5 }, (_, i) => ({
        ...amoxicilina,
        activeIngredient: `Principio ${i + 1}`,
      })),
    });
    expect(rx.items.map((item) => item.packages)).toEqual([
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});
