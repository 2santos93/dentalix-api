import { ClinicRole } from '@prisma/client';
import {
  POST_OP_MAX_NO_ANSWER,
  decideAttempt,
  overdueDays,
  postOpCheckDueOn,
  postOpHistoryText,
  seesClinicalDetail,
} from './post-op-check-rules';

const MON_FRI = { workingWeekdays: [1, 2, 3, 4, 5], holidays: [] };
const CARACAS = 'America/Caracas';

describe('postOpCheckDueOn (DX-566 · D3)', () => {
  it('extracción un lunes con control a 1 día: el martes', () => {
    // 2026-11-16 es lunes; 10:00 en Caracas (UTC−4).
    expect(
      postOpCheckDueOn(
        new Date('2026-11-16T14:00:00.000Z'),
        1,
        MON_FRI,
        null,
        CARACAS,
      ),
    ).toBe('2026-11-17');
  });

  it('cuenta el día civil de la SEDE, no el de UTC (22:00 del lunes en Caracas ya es martes en UTC)', () => {
    expect(
      postOpCheckDueOn(
        new Date('2026-11-17T02:00:00.000Z'),
        1,
        MON_FRI,
        null,
        CARACAS,
      ),
    ).toBe('2026-11-17');
  });

  it('un viernes salta el fin de semana: el lunes', () => {
    expect(
      postOpCheckDueOn(
        new Date('2026-11-20T15:00:00.000Z'),
        1,
        MON_FRI,
        null,
        CARACAS,
      ),
    ).toBe('2026-11-23');
  });

  it('salta un festivo de la sede (puntual y recurrente)', () => {
    const calendar = {
      workingWeekdays: [1, 2, 3, 4, 5],
      holidays: [
        { date: '2026-11-17', recurring: false },
        { date: '2020-11-18', recurring: true },
      ],
    };
    expect(
      postOpCheckDueOn(
        new Date('2026-11-16T14:00:00.000Z'),
        1,
        calendar,
        null,
        CARACAS,
      ),
    ).toBe('2026-11-19');
  });

  it('salta los días laborables sin tramos en el horario de la sede', () => {
    // Martes sin horario: del lunes pasa al miércoles.
    expect(
      postOpCheckDueOn(
        new Date('2026-11-16T14:00:00.000Z'),
        1,
        MON_FRI,
        [1, 3, 4, 5],
        CARACAS,
      ),
    ).toBe('2026-11-18');
  });

  it('con varios días cuenta solo hábiles', () => {
    expect(
      postOpCheckDueOn(
        new Date('2026-11-19T14:00:00.000Z'),
        3,
        MON_FRI,
        null,
        CARACAS,
      ),
    ).toBe('2026-11-24');
  });

  it('el cambio de hora no mueve la fecha (Nueva York, fin del horario de verano el domingo 1-nov-2026)', () => {
    const MON_SAT = { workingWeekdays: [1, 2, 3, 4, 5, 6], holidays: [] };
    // Sábado 31-oct 23:30 en Nueva York (UTC−4) = 03:30Z del domingo.
    expect(
      postOpCheckDueOn(
        new Date('2026-11-01T03:30:00.000Z'),
        1,
        MON_SAT,
        null,
        'America/New_York',
      ),
    ).toBe('2026-11-02');
    // Domingo 1-nov 23:30 (ya UTC−5) = 04:30Z del lunes: el lunes no cuenta.
    expect(
      postOpCheckDueOn(
        new Date('2026-11-02T04:30:00.000Z'),
        1,
        MON_SAT,
        null,
        'America/New_York',
      ),
    ).toBe('2026-11-02');
  });
});

describe('decideAttempt (DX-566 · D6)', () => {
  it.each(['FINE', 'DISCOMFORT', 'NEEDS_APPOINTMENT'] as const)(
    '%s cierra DONE con ese desenlace (aunque antes no contestara)',
    (outcome) => {
      expect(decideAttempt(0, outcome)).toEqual({
        close: true,
        status: 'DONE',
        outcome,
      });
      expect(decideAttempt(2, outcome)).toEqual({
        close: true,
        status: 'DONE',
        outcome,
      });
    },
  );

  it('tres «No contesta» lo cierran como No localizado (UNREACHABLE)', () => {
    expect(POST_OP_MAX_NO_ANSWER).toBe(3);
    expect(decideAttempt(0, 'NO_ANSWER')).toEqual({ close: false });
    expect(decideAttempt(1, 'NO_ANSWER')).toEqual({ close: false });
    expect(decideAttempt(2, 'NO_ANSWER')).toEqual({
      close: true,
      status: 'UNREACHABLE',
      outcome: null,
    });
  });
});

describe('recorte por rol y retraso', () => {
  it('solo los roles clínicos ven el detalle', () => {
    expect(seesClinicalDetail(ClinicRole.ADMIN)).toBe(true);
    expect(seesClinicalDetail(ClinicRole.DENTIST)).toBe(true);
    expect(seesClinicalDetail(ClinicRole.ASSISTANT)).toBe(true);
    expect(seesClinicalDetail(ClinicRole.RECEPTION)).toBe(false);
  });

  it('días de retraso civiles', () => {
    expect(overdueDays('2026-11-17', '2026-11-17')).toBe(0);
    expect(overdueDays('2026-11-14', '2026-11-17')).toBe(3);
    expect(overdueDays('2026-11-18', '2026-11-17')).toBe(0);
  });
});

describe('postOpHistoryText', () => {
  it('resultado, nota e intentos con quién y cuándo', () => {
    const text = postOpHistoryText({
      status: 'DONE',
      outcome: 'DISCOMFORT',
      procedureName: 'Extracción simple',
      attempts: [
        {
          outcome: 'NO_ANSWER',
          note: null,
          byName: 'Ana Recepción',
          at: '2026-11-17 09:10',
        },
        {
          outcome: 'DISCOMFORT',
          note: 'Dolor leve, toma analgésico',
          byName: 'Dra. Carmen Rojas',
          at: '2026-11-17 11:40',
        },
      ],
    });
    expect(text).toBe(
      [
        'Control postoperatorio por llamada: Extracción simple.',
        'Resultado: Molestias.',
        'Nota: Dolor leve, toma analgésico',
        'Intentos:',
        '1. 2026-11-17 09:10 · No contesta · Ana Recepción',
        '2. 2026-11-17 11:40 · Molestias · Dra. Carmen Rojas',
      ].join('\n'),
    );
  });

  it('No localizado tras tres intentos', () => {
    const at = '2026-11-17 09:00';
    const attempt = {
      outcome: 'NO_ANSWER' as const,
      note: null,
      byName: 'X',
      at,
    };
    expect(
      postOpHistoryText({
        status: 'UNREACHABLE',
        outcome: null,
        procedureName: 'Exodoncia',
        attempts: [attempt, attempt, attempt],
      }),
    ).toContain('Resultado: No localizado tras 3 intentos de llamada.');
  });
});
