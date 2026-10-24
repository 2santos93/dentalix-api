import {
  computePrescriptionHash,
  type PrescriptionHashInput,
} from './prescription-hash';
import type { SafetyAlert } from './prescription-safety';

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
  // Receta de antes de DX-300: sin avisos de seguridad (formato v1).
  safetyRulesVersion: null,
  safetyAlerts: null,
  safetyOverrideReason: null,
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

  it('regresión: una receta emitida antes de DX-300 conserva su hash v1', () => {
    // Valor calculado con el código de DX-013 antes de la migración: si el
    // formato v1 cambiara, las recetas ya emitidas dejarían de validar.
    expect(
      computePrescriptionHash({
        ...base,
        allergyOverride: true,
        allergyMatches: [
          { activeIngredient: 'Amoxicilina', allergen: 'Penicilina' },
        ],
      }),
    ).toBe('6b6384eb06021c3f7bb9eb02f5677252d60455d301b08c9b7e64f04981a569d7');
  });

  describe('v2 (DX-300): avisos y motivo dentro del hash', () => {
    const alert: SafetyAlert = {
      rule: 'INTERACTION',
      code: 'INTERACTION_ANTICOAGULANT_NSAID',
      severity: 'BLOCKING',
      activeIngredient: 'Ibuprofeno',
      message: 'Interacción grave',
      source: 'SDCEP',
    };
    const v2: PrescriptionHashInput = {
      ...base,
      safetyRulesVersion: 'RX_SAFETY_V1',
      safetyAlerts: [alert],
      safetyOverrideReason: 'Pauta corta pactada con hematología',
    };

    it('una receta nueva sin avisos ([]) ya no usa el formato v1', () => {
      expect(
        computePrescriptionHash({
          ...base,
          safetyRulesVersion: 'RX_SAFETY_V1',
          safetyAlerts: [],
        }),
      ).not.toBe(computePrescriptionHash(base));
    });

    it('cambia con el motivo, con un aviso o con la versión de las reglas', () => {
      const hash = computePrescriptionHash(v2);
      expect(
        computePrescriptionHash({ ...v2, safetyOverrideReason: 'Otro' }),
      ).not.toBe(hash);
      expect(
        computePrescriptionHash({
          ...v2,
          safetyAlerts: [{ ...alert, severity: 'INFO' }],
        }),
      ).not.toBe(hash);
      expect(
        computePrescriptionHash({ ...v2, safetyRulesVersion: 'RX_SAFETY_V2' }),
      ).not.toBe(hash);
    });
  });
});
