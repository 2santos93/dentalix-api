import type { MedicalHistory } from '../../medical-history/domain/entities/medical-history.entity';
import type { MedicalHistoryVersionData } from '../../medical-history/domain/ports/medical-history-repository.port';
import { diffMedicalHistory } from './history-diff';

const FLAGS = {
  embarazo: false,
  anticoagulantes: false,
  bifosfonatos: false,
  diabetes: false,
  profilaxisAntibiotica: false,
  alergiaAnestesico: false,
  alergiaPenicilina: false,
  alergiaLatex: false,
};

function version(overrides: Partial<MedicalHistory> = {}): MedicalHistory {
  return {
    id: 'v1',
    tenantId: 't',
    patientId: 'p',
    version: 1,
    allergies: [],
    conditions: [],
    medications: [],
    habits: null,
    dentalHistory: null,
    surgeries: [],
    vitalSigns: null,
    familyHistory: null,
    notes: null,
    safetyFlags: FLAGS,
    hasCriticalAlert: false,
    source: 'STAFF',
    createdById: 'u',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('diferencias entre la versión vigente y la propuesta (DX-099)', () => {
  it('sin versión previa todo aparece como nuevo, los «Sí» primero', () => {
    const proposed: MedicalHistoryVersionData = {
      allergies: [],
      conditions: [
        {
          codigo: 'HIPERTENSION',
          etiqueta: 'Hipertensión',
          estado: 'NO',
          esAlerta: false,
        },
        {
          codigo: 'DIABETES',
          etiqueta: 'Diabetes',
          estado: 'SI',
          esAlerta: true,
        },
      ],
      medications: [{ nombre: 'Warfarina', dosis: '5 mg', esAlerta: true }],
      habits: { tabaquismo: { activo: false } },
      surgeries: [],
      embarazo: false,
    };
    const diff = diffMedicalHistory(null, proposed);
    expect(diff.hasPreviousVersion).toBe(false);
    expect(diff.entries.every((e) => e.change === 'ADDED')).toBe(true);
    expect(diff.entries.every((e) => e.before === null)).toBe(true);
    expect(diff.entries.map((e) => [e.label, e.after, e.affirmative])).toEqual([
      ['Diabetes', 'Sí', true],
      ['Warfarina', '5 mg', true],
      ['Alergias', 'Ninguna', false],
      ['Hipertensión', 'No', false],
      ['Tabaquismo', 'No', false],
      ['Embarazo', 'No', false],
      ['Cirugías y hospitalizaciones', 'Ninguna', false],
    ]);
  });

  it('marca añadido, quitado y cambiado frente a la vigente, y no lista lo que no cambió', () => {
    const current = version({
      allergies: [
        {
          alergeno: 'Látex',
          tipo: 'MATERIAL',
          severidad: 'LEVE',
          esAlerta: true,
        },
        {
          alergeno: 'Ibuprofeno',
          tipo: 'MEDICAMENTO',
          severidad: 'MODERADA',
          esAlerta: true,
        },
      ],
      conditions: [
        {
          codigo: 'HIPERTENSION',
          etiqueta: 'Hipertensión',
          estado: 'SI',
          esAlerta: false,
        },
        { codigo: 'ASMA', etiqueta: 'Asma', estado: 'NO', esAlerta: false },
      ],
      medications: [{ nombre: 'Losartán', esAlerta: false }],
      habits: { bruxismo: true },
      safetyFlags: FLAGS,
    });
    const proposed: MedicalHistoryVersionData = {
      allergies: [
        {
          alergeno: 'latex',
          tipo: 'MATERIAL',
          severidad: 'ANAFILAXIA',
          esAlerta: true,
        },
        {
          alergeno: 'Penicilina',
          tipo: 'MEDICAMENTO',
          severidad: 'LEVE',
          esAlerta: true,
        },
      ],
      conditions: [
        {
          codigo: 'HIPERTENSION',
          etiqueta: 'Hipertensión',
          estado: 'NO',
          esAlerta: false,
        },
        { codigo: 'ASMA', etiqueta: 'Asma', estado: 'NO', esAlerta: false },
      ],
      medications: [{ nombre: 'Losartán', esAlerta: false }],
      habits: { bruxismo: true },
      surgeries: [],
      embarazo: false,
    };
    const diff = diffMedicalHistory(current, proposed);
    expect(diff.hasPreviousVersion).toBe(true);
    expect(
      diff.entries.map((e) => [e.change, e.label, e.before, e.after]),
    ).toEqual([
      ['CHANGED', 'Látex', 'Material · Leve', 'Material · Anafilaxia'],
      ['ADDED', 'Penicilina', null, 'Medicamento · Leve'],
      ['REMOVED', 'Ibuprofeno', 'Medicamento · Moderada', null],
      ['CHANGED', 'Hipertensión', 'Sí', 'No'],
    ]);
    expect(diff.entries.every((e) => e.affirmative)).toBe(true);
    expect(diff.unchangedCount).toBeGreaterThan(0);
  });

  it('embarazo y hábitos con su detalle', () => {
    const current = version({ habits: { tabaquismo: { activo: false } } });
    const diff = diffMedicalHistory(current, {
      habits: {
        tabaquismo: { activo: true, porDia: 10 },
        alcohol: { activo: true, frecuencia: 'Fines de semana' },
      },
      embarazo: true,
      semanasEmbarazo: 12,
    });
    expect(
      diff.entries.map((e) => [e.change, e.label, e.before, e.after]),
    ).toEqual([
      ['CHANGED', 'Tabaquismo', 'No', 'Sí (10 al día)'],
      ['ADDED', 'Alcohol', null, 'Sí (Fines de semana)'],
      ['CHANGED', 'Embarazo', 'No', 'Sí (12 semanas)'],
    ]);
  });

  it('una condición que la vigente no recogía estaba «Sin responder», nunca «No»', () => {
    const current = version({
      conditions: [
        {
          codigo: 'ASMA',
          etiqueta: 'Asma',
          estado: 'DESCONOCE',
          esAlerta: false,
        },
        { codigo: 'RENAL', etiqueta: 'Renal', estado: 'SI', esAlerta: false },
      ],
    });
    const diff = diffMedicalHistory(current, {
      conditions: [
        { codigo: 'ASMA', etiqueta: 'Asma', estado: 'NO', esAlerta: false },
        {
          codigo: 'HIPERTENSION',
          etiqueta: 'Hipertensión',
          estado: 'NO',
          esAlerta: false,
        },
      ],
    });
    const conditions = diff.entries.filter((e) => e.section === 'CONDITIONS');
    expect(
      conditions.map((e) => [e.change, e.label, e.before, e.after]),
    ).toEqual([
      ['REMOVED', 'Renal', 'Sí', 'Sin responder'],
      ['CHANGED', 'Asma', 'No sabe', 'No'],
      ['ADDED', 'Hipertensión', 'Sin responder', 'No'],
    ]);
    expect(
      conditions.some((e) => e.before === 'No' && e.change === 'ADDED'),
    ).toBe(false);
  });

  it('sin cambios: ninguna entrada', () => {
    const current = version({
      medications: [{ nombre: 'Losartán', esAlerta: false }],
    });
    const diff = diffMedicalHistory(current, {
      allergies: [],
      conditions: [],
      medications: [{ nombre: 'Losartán', esAlerta: false }],
      surgeries: [],
      embarazo: false,
    });
    expect(diff.entries).toEqual([]);
  });
});
