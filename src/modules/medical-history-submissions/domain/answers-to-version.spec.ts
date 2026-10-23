import type { MedicalHistory } from '../../medical-history/domain/entities/medical-history.entity';
import { deriveSafetyFlags } from '../../medical-history/domain/safety-flags';
import { ANAMNESIS_CONDITIONS } from './anamnesis-questionnaire';
import { allNoAnswers as allNo } from './__fixtures__/anamnesis-answers';
import {
  ANSWERS_MAX_BYTES,
  answersValidationErrors,
  countAffirmativeAnswers,
  proposeVersionFromAnswers,
} from './answers-to-version';

function current(overrides: Partial<MedicalHistory> = {}): MedicalHistory {
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
    safetyFlags: {
      embarazo: false,
      anticoagulantes: false,
      bifosfonatos: false,
      diabetes: false,
      profilaxisAntibiotica: false,
      alergiaAnestesico: false,
      alergiaPenicilina: false,
      alergiaLatex: false,
    },
    hasCriticalAlert: false,
    source: 'STAFF',
    createdById: 'u',
    createdAt: new Date('2025-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('respuestas del paciente → versión de la HC (DX-099)', () => {
  describe('validación', () => {
    it('todo «No» es válido', () => {
      expect(answersValidationErrors(allNo())).toEqual([]);
    });

    it('«Sí» a alergias exige al menos una alergia', () => {
      const a = allNo();
      a.allergies = { answer: 'SI', items: [] };
      expect(answersValidationErrors(a)).toEqual([
        'Indique al menos una alergia o cambie la respuesta.',
      ]);
    });

    it('«Sí» a medicamentos y a cirugías exige al menos uno', () => {
      const a = allNo();
      a.medications = { answer: 'SI' };
      a.surgeries = { answer: 'SI', items: [] };
      expect(answersValidationErrors(a)).toEqual([
        'Indique al menos un medicamento o cambie la respuesta.',
        'Indique al menos una cirugía u hospitalización o cambie la respuesta.',
      ]);
    });

    it('hay que contestar TODAS las condiciones del cuestionario, sin repetir ni inventar', () => {
      const a = allNo();
      a.conditions = a.conditions.slice(1);
      expect(answersValidationErrors(a)).toEqual([
        'Conteste todas las preguntas de enfermedades.',
      ]);
      const b = allNo();
      b.conditions = [...b.conditions, { codigo: 'INVENTADA', answer: 'SI' }];
      expect(answersValidationErrors(b)).toEqual([
        'Conteste todas las preguntas de enfermedades.',
      ]);
      const c = allNo();
      c.conditions = [...c.conditions, { ...c.conditions[0] }];
      expect(answersValidationErrors(c)).toEqual([
        'Conteste todas las preguntas de enfermedades.',
      ]);
    });

    it('un alérgeno o medicamento en blanco no vale', () => {
      const a = allNo();
      a.allergies = {
        answer: 'SI',
        items: [{ alergeno: '   ', tipo: 'MEDICAMENTO', severidad: 'LEVE' }],
      };
      expect(answersValidationErrors(a)).toEqual([
        'Escriba el nombre de cada alergia.',
      ]);
    });

    it('el envío entero tiene un tope en bytes: cada texto dentro de su límite pero todos llenos de caracteres multibyte no cabe', () => {
      // 200 caracteres de 3 bytes (UTF-8) en cada campo de 20 alergias y 20
      // medicamentos: el DTO los admite uno a uno, pero el total pasaría el
      // CHECK de 64 KB de la BD (un 500 en vez de un 400 en español).
      const long = '€'.repeat(200);
      const a = allNo();
      a.allergies = {
        answer: 'SI',
        items: Array.from({ length: 20 }, () => ({
          alergeno: long,
          reaccion: long,
          tipo: 'MEDICAMENTO' as const,
          severidad: 'LEVE' as const,
        })),
      };
      a.medications = {
        answer: 'SI',
        items: Array.from({ length: 20 }, () => ({
          nombre: long,
          dosis: long,
          frecuencia: long,
        })),
      };
      expect(answersValidationErrors(a)).toEqual([
        'Sus respuestas son demasiado largas: acorte los textos e inténtelo de nuevo.',
      ]);
      expect(Buffer.byteLength(JSON.stringify(a), 'utf8')).toBeGreaterThan(
        ANSWERS_MAX_BYTES,
      );
    });

    it('un envío largo pero razonable cabe', () => {
      const a = allNo();
      a.allergies = {
        answer: 'SI',
        items: Array.from({ length: 20 }, () => ({
          alergeno: 'a'.repeat(200),
          reaccion: 'b'.repeat(200),
          tipo: 'MEDICAMENTO' as const,
          severidad: 'LEVE' as const,
        })),
      };
      expect(answersValidationErrors(a)).toEqual([]);
    });
  });

  describe('mapeo sin versión previa', () => {
    it('una alergia declarada entra como alerta y enciende hasCriticalAlert', () => {
      const a = allNo();
      a.allergies = {
        answer: 'SI',
        items: [
          {
            alergeno: ' Penicilina ',
            tipo: 'MEDICAMENTO',
            severidad: 'ANAFILAXIA',
            reaccion: 'Edema',
          },
        ],
      };
      const proposed = proposeVersionFromAnswers(a, null);
      expect(proposed.allergies).toEqual([
        {
          alergeno: 'Penicilina',
          tipo: 'MEDICAMENTO',
          severidad: 'ANAFILAXIA',
          reaccion: 'Edema',
          esAlerta: true,
        },
      ]);
      const flags = deriveSafetyFlags(proposed);
      expect(flags.safetyFlags.alergiaPenicilina).toBe(true);
      expect(flags.hasCriticalAlert).toBe(true);
    });

    it('«Sí» a anticoagulantes añade el medicamento y enciende la bandera aunque no diga cuál', () => {
      const a = allNo();
      a.anticoagulants = { answer: 'SI' };
      const proposed = proposeVersionFromAnswers(a, null);
      expect(proposed.medications).toEqual([
        { nombre: 'Anticoagulante (sin especificar)', esAlerta: true },
      ]);
      const flags = deriveSafetyFlags(proposed);
      expect(flags.safetyFlags.anticoagulantes).toBe(true);
      expect(flags.hasCriticalAlert).toBe(true);
    });

    it('«Sí» a anticoagulantes con el nombre lo usa, y no lo duplica si ya está en la lista', () => {
      const a = allNo();
      a.anticoagulants = { answer: 'SI', detail: 'Warfarina' };
      a.medications = { answer: 'SI', items: [{ nombre: 'warfarina 5 mg' }] };
      expect(proposeVersionFromAnswers(a, null).medications).toEqual([
        { nombre: 'warfarina 5 mg', esAlerta: true },
      ]);
      const b = allNo();
      b.anticoagulants = { answer: 'SI', detail: 'Xarelto' };
      expect(proposeVersionFromAnswers(b, null).medications).toEqual([
        { nombre: 'Anticoagulante: Xarelto', esAlerta: true },
      ]);
    });

    it('las condiciones: Sí/No/No sé → SI/NO/DESCONOCE, alerta solo las que cambian la atención', () => {
      const a = allNo();
      a.conditions = a.conditions.map((c) =>
        c.codigo === 'DIABETES'
          ? { ...c, answer: 'SI', nota: 'Tipo 2' }
          : c.codigo === 'HIPERTENSION'
            ? { ...c, answer: 'SI' }
            : c.codigo === 'ASMA'
              ? { ...c, answer: 'NO_SE' }
              : c,
      );
      const proposed = proposeVersionFromAnswers(a, null);
      const byCode = new Map(proposed.conditions!.map((c) => [c.codigo, c]));
      expect(byCode.get('DIABETES')).toEqual({
        codigo: 'DIABETES',
        etiqueta: 'Diabetes',
        estado: 'SI',
        esAlerta: true,
        nota: 'Tipo 2',
      });
      expect(byCode.get('HIPERTENSION')?.esAlerta).toBe(false);
      expect(byCode.get('ASMA')?.estado).toBe('DESCONOCE');
      expect(proposed.conditions).toHaveLength(ANAMNESIS_CONDITIONS.length);
      expect(deriveSafetyFlags(proposed).safetyFlags.diabetes).toBe(true);
    });

    it('hábitos, embarazo y cirugías', () => {
      const a = allNo();
      a.habits = {
        tabaquismo: { answer: 'SI', porDia: 10 },
        alcohol: { answer: 'SI', frecuencia: 'Fines de semana' },
        bruxismo: { answer: 'SI' },
      };
      a.pregnancy = { answer: 'SI', semanas: 12 };
      a.surgeries = {
        answer: 'SI',
        items: [{ descripcion: 'Apendicectomía', fecha: '2015' }],
      };
      const proposed = proposeVersionFromAnswers(a, null);
      expect(proposed.habits).toEqual({
        tabaquismo: { activo: true, porDia: 10 },
        alcohol: { activo: true, frecuencia: 'Fines de semana' },
        bruxismo: true,
      });
      expect(proposed.embarazo).toBe(true);
      expect(proposed.semanasEmbarazo).toBe(12);
      expect(proposed.surgeries).toEqual([
        { descripcion: 'Apendicectomía', fecha: '2015' },
      ]);
    });
  });

  describe('mapeo sobre la versión vigente', () => {
    it('«No sé» conserva lo que ya había; «No» lo vacía; lo que el formulario no pregunta se conserva', () => {
      const prev = current({
        allergies: [
          {
            alergeno: 'Látex',
            tipo: 'MATERIAL',
            severidad: 'MODERADA',
            esAlerta: true,
          },
        ],
        medications: [{ nombre: 'Losartán', esAlerta: false }],
        surgeries: [{ descripcion: 'Cesárea' }],
        conditions: [
          {
            codigo: 'OTRA_CLINICA',
            etiqueta: 'Migraña',
            estado: 'SI',
            esAlerta: false,
          },
        ],
        habits: { higieneOral: { cepilladoPorDia: 3 }, dieta: 'Normal' },
        dentalHistory: { motivoConsulta: 'Control' },
        vitalSigns: { sistolica: 120 },
        familyHistory: 'Diabetes (madre)',
        notes: 'Nota del doctor',
        safetyFlags: { ...current().safetyFlags, embarazo: true },
      });
      const a = allNo();
      a.allergies = { answer: 'NO_SE' };
      a.medications = { answer: 'NO' };
      a.surgeries = { answer: 'NO_SE' };
      a.pregnancy = { answer: 'NO_SE' };
      a.habits.bruxismo = { answer: 'NO_SE' };
      const proposed = proposeVersionFromAnswers(a, prev);
      expect(proposed.allergies).toEqual(prev.allergies);
      expect(proposed.medications).toEqual([]);
      expect(proposed.surgeries).toEqual(prev.surgeries);
      expect(proposed.embarazo).toBe(true);
      // La condición propia de la clínica sigue, delante de las del cuestionario.
      expect(proposed.conditions![0].codigo).toBe('OTRA_CLINICA');
      expect(proposed.habits).toEqual({
        higieneOral: { cepilladoPorDia: 3 },
        dieta: 'Normal',
        tabaquismo: { activo: false },
        alcohol: { activo: false },
      });
      expect(proposed.dentalHistory).toEqual(prev.dentalHistory);
      expect(proposed.vitalSigns).toEqual(prev.vitalSigns);
      expect(proposed.familyHistory).toBe('Diabetes (madre)');
      expect(proposed.notes).toBe('Nota del doctor');
    });
  });

  it('cuenta los «Sí» del envío (lo que se revisa primero)', () => {
    const a = allNo();
    expect(countAffirmativeAnswers(a)).toBe(0);
    a.allergies = {
      answer: 'SI',
      items: [{ alergeno: 'Látex', tipo: 'MATERIAL', severidad: 'LEVE' }],
    };
    a.anticoagulants = { answer: 'SI' };
    a.conditions[0] = { ...a.conditions[0], answer: 'SI' };
    expect(countAffirmativeAnswers(a)).toBe(3);
  });
});
