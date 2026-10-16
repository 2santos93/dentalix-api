import { ClinicCountry } from '@prisma/client';
import {
  computeValidUntil,
  PRESCRIPTION_VALIDITY_DAYS,
  validatePrescription,
  type PrescriptionItemInput,
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
  packages: 1,
  ...extra,
});

const patientCo = { docNumber: '1020304050', birthDate: null };
const patientEs = { docNumber: '12345678Z', birthDate: new Date('1980-05-04') };

describe('validatePrescription — Colombia (Dec. 780/2016)', () => {
  it('acepta una receta completa con varios medicamentos y sin nº de envases', () => {
    expect(
      validatePrescription(ClinicCountry.CO, {
        items: [
          item({ packages: undefined }),
          item({ activeIngredient: 'Ibuprofeno' }),
        ],
        patient: patientCo,
        professionalLicense: 'RM-12345',
      }),
    ).toEqual([]);
  });

  it('exige cada campo del medicamento y dice cuál falta y en qué medicamento', () => {
    const errors = validatePrescription(ClinicCountry.CO, {
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
      ],
      patient: patientCo,
      professionalLicense: 'RM-1',
    });
    expect(errors).toEqual([
      'Medicamento 2: falta el principio activo (DCI)',
      'Medicamento 2: falta la concentración',
      'Medicamento 2: falta la forma farmacéutica',
      'Medicamento 2: falta la vía de administración',
      'Medicamento 2: falta la dosis',
      'Medicamento 2: falta la frecuencia',
      'Medicamento 2: falta la duración del tratamiento (días)',
      'Medicamento 2: falta la cantidad total',
      'Medicamento 2: falta la unidad de la cantidad (p. ej. tabletas)',
    ]);
  });

  it('exige el nº de historia clínica (documento del paciente) y el registro profesional', () => {
    expect(
      validatePrescription(ClinicCountry.CO, {
        items: [item()],
        patient: { docNumber: null, birthDate: null },
        professionalLicense: '  ',
      }),
    ).toEqual([
      'Falta el número de historia clínica: registra el documento del paciente en sus datos',
      'Falta tu registro profesional',
    ]);
  });

  it('valida rangos: duración 1–365, cantidad 1–9999 y envases 1–99', () => {
    expect(
      validatePrescription(ClinicCountry.CO, {
        items: [item({ durationDays: 0, totalQuantity: 10000, packages: 100 })],
        patient: patientCo,
        professionalLicense: 'RM-1',
      }),
    ).toEqual([
      'Medicamento 1: la duración debe ser un número entero de días entre 1 y 365',
      'Medicamento 1: la cantidad total debe ser un número entero entre 1 y 9999',
      'Medicamento 1: el número de envases debe ser un entero entre 1 y 99',
    ]);
  });

  it('pide al menos un medicamento y como mucho 10', () => {
    const base = { patient: patientCo, professionalLicense: 'RM-1' };
    expect(
      validatePrescription(ClinicCountry.CO, { ...base, items: [] }),
    ).toEqual(['La receta necesita al menos un medicamento']);
    expect(
      validatePrescription(ClinicCountry.CO, {
        ...base,
        items: Array.from({ length: 11 }, () => item()),
      }),
    ).toEqual(['Una receta admite como mucho 10 medicamentos']);
  });
});

describe('validatePrescription — España (RD 1718/2010)', () => {
  it('acepta una receta completa', () => {
    expect(
      validatePrescription(ClinicCountry.ES, {
        items: [item()],
        patient: patientEs,
        professionalLicense: '28/012345',
      }),
    ).toEqual([]);
  });

  it('exige además DNI/NIE, año de nacimiento, nº de envases y nº de colegiado', () => {
    expect(
      validatePrescription(ClinicCountry.ES, {
        items: [item({ packages: undefined })],
        patient: { docNumber: null, birthDate: null },
        professionalLicense: null,
      }),
    ).toEqual([
      'Medicamento 1: falta el número de envases',
      'Falta el DNI/NIE del paciente: regístralo en sus datos',
      'Falta el año de nacimiento del paciente: registra su fecha de nacimiento',
      'Falta tu número de colegiado',
    ]);
  });

  it('una receta por medicamento', () => {
    expect(
      validatePrescription(ClinicCountry.ES, {
        items: [item(), item()],
        patient: patientEs,
        professionalLicense: '28/1',
      }),
    ).toEqual([
      'En España cada receta lleva un solo medicamento: emite una receta por medicamento',
    ]);
  });
});

describe('computeValidUntil', () => {
  it('ES: 10 días naturales desde la fecha prevista de dispensación (incluida)', () => {
    expect(PRESCRIPTION_VALIDITY_DAYS.ES).toBe(10);
    expect(computeValidUntil(ClinicCountry.ES, '2026-10-16')).toBe(
      '2026-10-25',
    );
    expect(computeValidUntil(ClinicCountry.ES, '2026-12-28')).toBe(
      '2027-01-06',
    );
  });

  it('CO: 30 días naturales desde la fecha de la receta', () => {
    expect(PRESCRIPTION_VALIDITY_DAYS.CO).toBe(30);
    expect(computeValidUntil(ClinicCountry.CO, '2026-02-01')).toBe(
      '2026-03-02',
    );
  });
});
