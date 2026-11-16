import {
  LAB_MESSAGES,
  checkEdit,
  checkTransition,
  civilDaysBetween,
  deriveLabOrderStatus,
  effectiveBusinessCalendar,
  labOrderOverdue,
  normalizeCancelReason,
  normalizeTeeth,
  optionalText,
  suggestDueOn,
  type LabOrderSteps,
} from './lab-order-rules';

const T = new Date('2026-11-20T15:00:00.000Z');
const draft: LabOrderSteps = {
  sentAt: null,
  receivedAt: null,
  checkedAt: null,
  cancelledAt: null,
};
const sent = { ...draft, sentAt: T };
const received = { ...sent, receivedAt: T };
const checked = { ...received, checkedAt: T };
const cancelled = { ...sent, cancelledAt: T };

const MON_FRI = { workingWeekdays: [1, 2, 3, 4, 5], holidays: [] };
const ZONE = 'America/Caracas';

describe('estado derivado (DX-017)', () => {
  it('sale de la fecha más alta puesta; la anulación manda', () => {
    expect(deriveLabOrderStatus(draft)).toBe('DRAFT');
    expect(deriveLabOrderStatus(sent)).toBe('SENT');
    expect(deriveLabOrderStatus(received)).toBe('RECEIVED');
    expect(deriveLabOrderStatus(checked)).toBe('CHECKED');
    expect(deriveLabOrderStatus(cancelled)).toBe('CANCELLED');
    expect(deriveLabOrderStatus({ ...received, cancelledAt: T })).toBe(
      'CANCELLED',
    );
  });
});

describe('atrasada', () => {
  const today = '2026-11-20';

  it('fecha prometida anterior a hoy, sin recibir ni anular: atrasada con días naturales', () => {
    expect(labOrderOverdue({ dueOn: '2026-11-17', ...sent }, today)).toEqual({
      overdue: true,
      daysOverdue: 3,
    });
    expect(labOrderOverdue({ dueOn: '2026-10-31', ...draft }, today)).toEqual({
      overdue: true,
      daysOverdue: 20,
    });
  });

  it('hoy mismo, sin fecha, recibida o anulada: no está atrasada', () => {
    for (const o of [
      { dueOn: today, ...sent },
      { dueOn: '2026-11-21', ...sent },
      { dueOn: null, ...sent },
      { dueOn: '2026-11-01', ...received },
      { dueOn: '2026-11-01', ...cancelled },
    ]) {
      expect(labOrderOverdue(o, today)).toEqual({
        overdue: false,
        daysOverdue: null,
      });
    }
  });

  it('cuenta días civiles aunque cambie la hora (sin milisegundos)', () => {
    expect(civilDaysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(civilDaysBetween('2026-10-31', '2026-11-02')).toBe(2);
  });
});

describe('fecha prometida sugerida en días hábiles', () => {
  it('«Corona zirconio» (5 días hábiles) enviada un viernes: el viernes siguiente', () => {
    // 2026-11-20 es viernes.
    expect(suggestDueOn('2026-11-20', 5, MON_FRI, ZONE)).toBe('2026-11-27');
  });

  it('salta los festivos de la sede (puntuales y recurrentes)', () => {
    const calendar = {
      workingWeekdays: [1, 2, 3, 4, 5],
      holidays: [
        { date: '2026-11-24', recurring: false },
        { date: '2020-11-26', recurring: true },
      ],
    };
    expect(suggestDueOn('2026-11-20', 5, calendar, ZONE)).toBe('2026-12-01');
  });

  it('salta los días sin tramos en el horario de la sede (miércoles cerrado)', () => {
    const calendar = effectiveBusinessCalendar(MON_FRI, [1, 2, 4, 5, 6]);
    expect(calendar.workingWeekdays).toEqual([1, 2, 4, 5]);
    expect(suggestDueOn('2026-11-20', 5, calendar, ZONE)).toBe('2026-11-30');
  });

  it('sin horario configurado no restringe; sin ningún día en común manda el calendario', () => {
    expect(effectiveBusinessCalendar(MON_FRI, null)).toBe(MON_FRI);
    expect(effectiveBusinessCalendar(MON_FRI, [0, 6])).toBe(MON_FRI);
  });

  it('plazo 0: el mismo día de inicio', () => {
    expect(suggestDueOn('2026-11-21', 0, MON_FRI, ZONE)).toBe('2026-11-21');
  });
});

describe('transiciones', () => {
  it('enviar: solo una vez y nunca anulada', () => {
    expect(checkTransition(draft, 'SEND')).toBeNull();
    expect(checkTransition(sent, 'SEND')).toEqual({
      kind: 'CONFLICT',
      message: LAB_MESSAGES.alreadySent,
    });
    expect(checkTransition(cancelled, 'SEND')).toEqual({
      kind: 'CONFLICT',
      message: LAB_MESSAGES.cancelled,
    });
  });

  it('recibir sin enviar → 422 en español; dos veces → 409', () => {
    expect(checkTransition(draft, 'RECEIVE')).toEqual({
      kind: 'UNPROCESSABLE',
      message: 'No se puede recibir una orden que no se ha enviado.',
    });
    expect(checkTransition(sent, 'RECEIVE')).toBeNull();
    expect(checkTransition(received, 'RECEIVE')?.kind).toBe('CONFLICT');
  });

  it('revisar sin recibir → 422; dos veces → 409', () => {
    expect(checkTransition(sent, 'CHECK')).toEqual({
      kind: 'UNPROCESSABLE',
      message: 'No se puede revisar una orden que no se ha recibido.',
    });
    expect(checkTransition(received, 'CHECK')).toBeNull();
    expect(checkTransition(checked, 'CHECK')?.kind).toBe('CONFLICT');
  });

  it('anular: borrador, enviada o recibida; una revisada o anulada no', () => {
    expect(checkTransition(draft, 'CANCEL')).toBeNull();
    expect(checkTransition(sent, 'CANCEL')).toBeNull();
    expect(checkTransition(received, 'CANCEL')).toBeNull();
    expect(checkTransition(checked, 'CANCEL')).toEqual({
      kind: 'CONFLICT',
      message: LAB_MESSAGES.checkedNotCancellable,
    });
    expect(checkTransition(cancelled, 'CANCEL')?.kind).toBe('CONFLICT');
  });
});

describe('edición', () => {
  it('en borrador, todo; tras «Enviada», solo la fecha prometida y la cita', () => {
    expect(checkEdit(draft, ['description', 'shade', 'dueOn'])).toBeNull();
    expect(checkEdit(sent, ['dueOn', 'appointmentId'])).toBeNull();
    expect(checkEdit(sent, ['dueOn', 'instructions'])).toEqual({
      kind: 'CONFLICT',
      message:
        'La orden ya se envió: para corregirla crea una orden nueva que la sustituya.',
    });
  });

  it('una anulada no se toca', () => {
    expect(checkEdit(cancelled, ['dueOn'])).toEqual({
      kind: 'CONFLICT',
      message: 'La orden está anulada: no se puede modificar.',
    });
  });
});

describe('valores', () => {
  it('dientes FDI sin repetir', () => {
    expect(normalizeTeeth(['16', ' 26 ', '85'])).toEqual({
      ok: true,
      value: ['16', '26', '85'],
    });
    expect(normalizeTeeth(undefined)).toEqual({ ok: true, value: [] });
    for (const bad of [['19'], ['16', '16'], ['00'], ['86'], ['1']]) {
      expect(normalizeTeeth(bad)).toEqual({
        ok: false,
        message: LAB_MESSAGES.teethInvalid,
      });
    }
    expect(
      normalizeTeeth(Array.from({ length: 33 }, () => '11')),
    ).toMatchObject({ ok: false, message: LAB_MESSAGES.teethTooMany });
  });

  it('textos opcionales: recortados y en blanco → null', () => {
    expect(optionalText('  A2 ')).toBe('A2');
    expect(optionalText('   ')).toBeNull();
    expect(optionalText(null)).toBeNull();
  });

  it('motivo de anulación de 3 a 500 caracteres', () => {
    expect(normalizeCancelReason('  El paciente cambió de plan  ')).toBe(
      'El paciente cambió de plan',
    );
    expect(normalizeCancelReason('no')).toBeNull();
    expect(normalizeCancelReason('x'.repeat(501))).toBeNull();
    expect(normalizeCancelReason(undefined)).toBeNull();
  });
});
