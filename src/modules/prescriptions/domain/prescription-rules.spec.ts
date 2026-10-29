import {
  computeValidUntil,
  MAX_PRESCRIPTION_ITEMS,
  validatePrescription,
  type PrescriptionItemInput,
  type PrescriptionValidationInput,
} from './prescription-rules';

const item = (
  extra: Partial<PrescriptionItemInput> = {},
): PrescriptionItemInput => ({
  activeIngredient: 'Amoxicilina',
  concentration: '500 mg',
  pharmaceuticalForm: 'Cápsula',
  route: 'Oral',
  dose: '1 cápsula',
  frequency: 'Cada 8 horas',
  durationDays: 7,
  totalQuantity: 21,
  quantityUnit: 'cápsulas',
  ...extra,
});

const valid = (
  extra: Partial<PrescriptionValidationInput> = {},
): PrescriptionValidationInput => ({
  items: [item()],
  patient: { docNumber: '1020304050' },
  professionalLicense: 'RP-12345',
  requireClinicalRecordNumber: false,
  ...extra,
});

const HC_MESSAGE =
  'Falta el número de historia clínica: registra el documento del paciente en sus datos';
const LICENSE_MESSAGE = 'Falta tu número de registro profesional';

describe('validatePrescription', () => {
  it('validatePrescription takes no location or country', () => {
    expect(validatePrescription.length).toBe(1);
    // @ts-expect-error: la regla no recibe país.
    validatePrescription({ ...valid(), country: 'CO' });
  });

  it('a five-item prescription with no packages, no birth date and no document is valid when HC is not required', () => {
    expect(
      validatePrescription(
        valid({
          items: Array.from({ length: 5 }, (_, i) =>
            item({ activeIngredient: `Principio ${i + 1}` }),
          ),
          patient: { docNumber: null },
        }),
      ),
    ).toEqual([]);
  });

  it('requireClinicalRecordNumber decides the HC rule, nothing else', () => {
    for (const docNumber of [null, '', '   ']) {
      expect(
        validatePrescription(
          valid({ patient: { docNumber }, requireClinicalRecordNumber: true }),
        ),
      ).toEqual([HC_MESSAGE]);
      expect(
        validatePrescription(
          valid({ patient: { docNumber }, requireClinicalRecordNumber: false }),
        ),
      ).toEqual([]);
    }
    expect(
      validatePrescription(valid({ requireClinicalRecordNumber: true })),
    ).toEqual([]);
  });

  it('missing license is «Falta tu número de registro profesional»', () => {
    for (const professionalLicense of [null, undefined, '', '  ']) {
      expect(validatePrescription(valid({ professionalLicense }))).toEqual([
        LICENSE_MESSAGE,
      ]);
    }
  });

  it('11 items is the 10-item limit message', () => {
    expect(MAX_PRESCRIPTION_ITEMS).toBe(10);
    expect(
      validatePrescription(
        valid({ items: Array.from({ length: 10 }, () => item()) }),
      ),
    ).toEqual([]);
    expect(
      validatePrescription(
        valid({ items: Array.from({ length: 11 }, () => item()) }),
      ),
    ).toEqual(['Una receta admite como mucho 10 medicamentos']);
  });

  it('0 items needs at least one medication', () => {
    expect(validatePrescription(valid({ items: [] }))).toEqual([
      'La receta necesita al menos un medicamento',
    ]);
  });

  it('packages 0 and 100 are range errors; absent packages is fine', () => {
    const range =
      'Medicamento 1: el número de envases debe ser un entero entre 1 y 99';
    expect(
      validatePrescription(valid({ items: [item({ packages: 0 })] })),
    ).toEqual([range]);
    expect(
      validatePrescription(valid({ items: [item({ packages: 100 })] })),
    ).toEqual([range]);
    for (const packages of [undefined, null, 1, 99]) {
      expect(
        validatePrescription(valid({ items: [item({ packages })] })),
      ).toEqual([]);
    }
  });

  it('all item errors come together, then HC, then license', () => {
    expect(
      validatePrescription({
        items: [
          item(),
          item({
            activeIngredient: ' ',
            concentration: '',
            pharmaceuticalForm: undefined,
            route: '',
            dose: '',
            frequency: '',
            durationDays: undefined,
            totalQuantity: undefined,
            quantityUnit: '',
          }),
          item({ durationDays: 0, totalQuantity: 10000, packages: 100 }),
        ],
        patient: { docNumber: null },
        professionalLicense: null,
        requireClinicalRecordNumber: true,
      }),
    ).toEqual([
      'Medicamento 2: falta el principio activo (DCI)',
      'Medicamento 2: falta la concentración',
      'Medicamento 2: falta la forma farmacéutica',
      'Medicamento 2: falta la vía de administración',
      'Medicamento 2: falta la dosis',
      'Medicamento 2: falta la frecuencia',
      'Medicamento 2: falta la duración del tratamiento (días)',
      'Medicamento 2: falta la cantidad total',
      'Medicamento 2: falta la unidad de la cantidad (p. ej. tabletas)',
      'Medicamento 3: la duración debe ser un número entero de días entre 1 y 365',
      'Medicamento 3: la cantidad total debe ser un número entero entre 1 y 9999',
      'Medicamento 3: el número de envases debe ser un entero entre 1 y 99',
      HC_MESSAGE,
      LICENSE_MESSAGE,
    ]);
  });
});

describe('computeValidUntil', () => {
  it.each([
    ['2027-02-25', 10, '2027-03-06'],
    ['2027-12-31', 1, '2027-12-31'],
    ['2028-02-28', 2, '2028-02-29'],
    ['2027-01-01', 365, '2027-12-31'],
  ])('(%s, %i) → %s', (start, days, expected) => {
    expect(computeValidUntil(start, days)).toBe(expected);
  });
});
