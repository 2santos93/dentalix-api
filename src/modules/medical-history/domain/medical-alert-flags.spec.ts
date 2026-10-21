import { deriveSafetyFlags } from './safety-flags';
import {
  NO_ANAMNESIS_FLAGS,
  deriveMedicalAlertFlags,
  lastAnamnesisReview,
  type AnamnesisSnapshot,
} from './medical-alert-flags';
import type { Allergy, Condition } from './entities/medical-history.entity';

const NOW = new Date('2026-10-20T15:00:00.000Z');
const RECENT = new Date('2026-09-01T12:00:00.000Z');
const OLD = new Date('2025-01-15T12:00:00.000Z');

function snapshot(
  input: {
    allergies?: Allergy[];
    conditions?: Condition[];
    medications?: { nombre: string; esAlerta: boolean }[];
    embarazo?: boolean;
  },
  createdAt = RECENT,
): AnamnesisSnapshot {
  const { safetyFlags, hasCriticalAlert } = deriveSafetyFlags(input);
  return {
    versionId: 'v-1',
    safetyFlags,
    hasCriticalAlert,
    alertAllergens: (input.allergies ?? [])
      .filter((a) => a.esAlerta)
      .map((a) => a.alergeno),
    createdAt,
  };
}

const valvulopatia: Condition = {
  codigo: 'VALVULOPATIA',
  etiqueta: 'Valvulopatía',
  estado: 'SI',
  esAlerta: true,
};

describe('deriveMedicalAlertFlags (DX-247)', () => {
  it('sin anamnesis: MISSING y sin alertas, nunca «al día»', () => {
    expect(deriveMedicalAlertFlags(null, null, 12, NOW)).toEqual(
      NO_ANAMNESIS_FLAGS,
    );
    expect(NO_ANAMNESIS_FLAGS).toEqual({
      hasCriticalAlert: false,
      requiresPremedication: false,
      anamnesisStatus: 'MISSING',
      alerts: [],
      anamnesisReviewedAt: null,
    });
  });

  it('profilaxis antibiótica → requiresPremedication y la alerta', () => {
    const flags = deriveMedicalAlertFlags(
      snapshot({ conditions: [valvulopatia] }),
      null,
      12,
      NOW,
    );
    expect(flags).toEqual({
      hasCriticalAlert: true,
      requiresPremedication: true,
      anamnesisStatus: 'CURRENT',
      alerts: ['profilaxisAntibiotica'],
      anamnesisReviewedAt: RECENT,
    });
  });

  it('una anamnesis limpia y al día no tiene alertas', () => {
    const flags = deriveMedicalAlertFlags(snapshot({}), null, 12, NOW);
    expect(flags.hasCriticalAlert).toBe(false);
    expect(flags.alerts).toEqual([]);
    expect(flags.anamnesisStatus).toBe('CURRENT');
  });

  it('las alertas salen en el orden del banner de la ficha', () => {
    const flags = deriveMedicalAlertFlags(
      snapshot({
        embarazo: true,
        conditions: [
          valvulopatia,
          {
            codigo: 'DIABETES',
            etiqueta: 'Diabetes',
            estado: 'SI',
            esAlerta: true,
          },
        ],
        medications: [{ nombre: 'Warfarina', esAlerta: true }],
        allergies: [
          {
            alergeno: 'Látex',
            tipo: 'MATERIAL',
            severidad: 'LEVE',
            esAlerta: true,
          },
          {
            alergeno: 'Penicilina',
            tipo: 'MEDICAMENTO',
            severidad: 'ANAFILAXIA',
            esAlerta: true,
          },
        ],
      }),
      null,
      12,
      NOW,
    );
    expect(flags.alerts).toEqual([
      'embarazo',
      'anticoagulantes',
      'diabetes',
      'profilaxisAntibiotica',
      'alergiaPenicilina',
      'alergiaLatex',
    ]);
  });

  it('una alergia marcada como alerta fuera de las conocidas sale como «alergiaMarcada», sin el alérgeno', () => {
    const flags = deriveMedicalAlertFlags(
      snapshot({
        allergies: [
          {
            alergeno: 'Ibuprofeno',
            tipo: 'MEDICAMENTO',
            severidad: 'MODERADA',
            esAlerta: true,
          },
          {
            alergeno: 'Polen',
            tipo: 'AMBIENTAL',
            severidad: 'LEVE',
            esAlerta: false,
          },
        ],
      }),
      null,
      12,
      NOW,
    );
    expect(flags.hasCriticalAlert).toBe(true);
    expect(flags.alerts).toEqual(['alergiaMarcada']);
    expect(JSON.stringify(flags)).not.toContain('Ibuprofeno');
  });

  it('una alergia marcada que ya es una bandera conocida no se repite', () => {
    const flags = deriveMedicalAlertFlags(
      snapshot({
        allergies: [
          {
            alergeno: 'Amoxicilina',
            tipo: 'MEDICAMENTO',
            severidad: 'MODERADA',
            esAlerta: true,
          },
        ],
      }),
      null,
      12,
      NOW,
    );
    expect(flags.alerts).toEqual(['alergiaPenicilina']);
  });

  it('anamnesis más antigua que la vigencia → EXPIRED (y conserva las alertas)', () => {
    const flags = deriveMedicalAlertFlags(
      snapshot({ conditions: [valvulopatia] }, OLD),
      null,
      12,
      NOW,
    );
    expect(flags.anamnesisStatus).toBe('EXPIRED');
    expect(flags.anamnesisReviewedAt).toEqual(OLD);
    expect(flags.requiresPremedication).toBe(true);
  });

  it('«Sin cambios hoy» posterior reinicia la vigencia', () => {
    const reviewed = new Date('2026-10-20T14:00:00.000Z');
    const flags = deriveMedicalAlertFlags(snapshot({}, OLD), reviewed, 12, NOW);
    expect(flags.anamnesisStatus).toBe('CURRENT');
    expect(flags.anamnesisReviewedAt).toEqual(reviewed);
  });

  it('una confirmación anterior a la versión vigente no cuenta más que la versión', () => {
    expect(lastAnamnesisReview(RECENT, OLD)).toEqual(RECENT);
    expect(lastAnamnesisReview(OLD, RECENT)).toEqual(RECENT);
    expect(lastAnamnesisReview(OLD, null)).toEqual(OLD);
  });

  it('banderas guardadas antes de DX-247 sin JSON: sin alertas, pero cuenta hasCriticalAlert', () => {
    const flags = deriveMedicalAlertFlags(
      {
        versionId: 'v-0',
        safetyFlags: null,
        hasCriticalAlert: true,
        alertAllergens: [],
        createdAt: RECENT,
      },
      null,
      12,
      NOW,
    );
    expect(flags.hasCriticalAlert).toBe(true);
    expect(flags.requiresPremedication).toBe(false);
    expect(flags.alerts).toEqual([]);
  });
});
