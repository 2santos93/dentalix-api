import {
  computePrescriptionHash,
  type PrescriptionHashInput,
} from './prescription-hash';

const base: PrescriptionHashInput = {
  country: 'CO',
  issuedAt: new Date('2026-10-16T15:00:00.000Z'),
  dispensationDate: '2026-10-16',
  validUntil: '2026-11-14',
  patientId: 'p1',
  patientName: 'Ana Pérez',
  patientDocument: 'CC 123',
  patientBirthYear: null,
  clinicalRecordNumber: '123',
  professionalId: 'u1',
  professionalName: 'Dra. Ruiz',
  professionalLicense: 'RM-1',
  professionalEmail: null,
  clinicName: 'Clínica',
  locationName: 'Sede',
  locationAddress: null,
  notes: null,
  allergyOverride: false,
  allergyMatches: [],
  items: [
    {
      position: 1,
      activeIngredient: 'Amoxicilina',
      brandName: null,
      concentration: '500 mg',
      pharmaceuticalForm: 'Cápsula',
      route: 'Oral',
      dose: '1 cápsula',
      frequency: 'Cada 8 horas',
      durationDays: 7,
      totalQuantity: 21,
      quantityUnit: 'cápsulas',
      quantityInWords: 'veintiuno',
      packages: null,
      instructions: null,
    },
  ],
};

describe('computePrescriptionHash', () => {
  it('es un SHA-256 hex estable', () => {
    const hash = computePrescriptionHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePrescriptionHash({ ...base })).toBe(hash);
  });

  it('cambia con cualquier dato del contenido, también de un medicamento', () => {
    const hash = computePrescriptionHash(base);
    expect(
      computePrescriptionHash({ ...base, patientName: 'Ana Perez' }),
    ).not.toBe(hash);
    expect(
      computePrescriptionHash({
        ...base,
        items: [{ ...base.items[0], totalQuantity: 22 }],
      }),
    ).not.toBe(hash);
  });

  it('no confunde fronteras entre campos', () => {
    expect(
      computePrescriptionHash({ ...base, clinicName: 'ab', locationName: 'c' }),
    ).not.toBe(
      computePrescriptionHash({ ...base, clinicName: 'a', locationName: 'bc' }),
    );
  });
});
