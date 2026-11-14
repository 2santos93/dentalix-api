import {
  RECALL_APPOINTMENT_TYPE_INVALID_MESSAGE,
  RECALL_EXCLUSION_GROUP_MESSAGE,
  RECALL_TYPE_INTERVAL_MESSAGE,
  RECALL_TYPE_NAME_EMPTY_MESSAGE,
  RECALL_TYPE_NAME_TOO_LONG_MESSAGE,
  RECALL_TYPE_SORT_MESSAGE,
  RECALL_TYPE_TRIGGERS_MAX_MESSAGE,
  exclusionGroupError,
  normalizeTriggerIds,
  recallAppointmentTypeError,
  recallTypeIntervalError,
  recallTypeNameError,
  recallTypeSortOrderError,
  triggerIdsError,
} from './recall-type-rules';

// DX-015-bis (D11–D13): reglas de un tipo de recall, puras.
describe('reglas de un tipo de recall (DX-015-bis)', () => {
  it('nombre: 1–60 caracteres sin contar los espacios de los extremos', () => {
    expect(recallTypeNameError('Higiene')).toBeNull();
    expect(recallTypeNameError('  Blanqueamiento  ')).toBeNull();
    expect(recallTypeNameError('x'.repeat(60))).toBeNull();
    expect(recallTypeNameError('   ')).toBe(RECALL_TYPE_NAME_EMPTY_MESSAGE);
    expect(recallTypeNameError('')).toBe(RECALL_TYPE_NAME_EMPTY_MESSAGE);
    expect(recallTypeNameError('x'.repeat(61))).toBe(
      RECALL_TYPE_NAME_TOO_LONG_MESSAGE,
    );
  });

  it.each([1, 6, 36])('intervalo por defecto %i: válido', (months) => {
    expect(recallTypeIntervalError(months)).toBeNull();
  });

  it.each([0, 37, -1, 2.5, Number.NaN])(
    'intervalo por defecto %p: 400 en español',
    (months) => {
      expect(recallTypeIntervalError(months)).toBe(
        RECALL_TYPE_INTERVAL_MESSAGE,
      );
    },
  );

  it.each([null, 'HYGIENE_PERIO', 'A', '9_ORTO', '_', 'X'.repeat(40)])(
    'grupo de exclusión %p: válido (null = sin exclusión)',
    (group) => {
      expect(exclusionGroupError(group)).toBeNull();
    },
  );

  it.each([
    '',
    'hygiene',
    'HIGIENE-PERIO',
    'HIGIENE PERIO',
    'Ñ',
    'X'.repeat(41),
  ])('grupo de exclusión %p: 400 en español', (group) => {
    expect(exclusionGroupError(group)).toBe(RECALL_EXCLUSION_GROUP_MESSAGE);
  });

  it('orden: entero de 0 a 9999', () => {
    expect(recallTypeSortOrderError(0)).toBeNull();
    expect(recallTypeSortOrderError(9999)).toBeNull();
    expect(recallTypeSortOrderError(-1)).toBe(RECALL_TYPE_SORT_MESSAGE);
    expect(recallTypeSortOrderError(10_000)).toBe(RECALL_TYPE_SORT_MESSAGE);
    expect(recallTypeSortOrderError(1.5)).toBe(RECALL_TYPE_SORT_MESSAGE);
  });

  it('disparadores: el conjunto, sin repetidos ni mayúsculas, hasta 50', () => {
    const a = '0B7D1C2E-0000-4000-8000-000000000001';
    const b = '0b7d1c2e-0000-4000-8000-000000000000';
    expect(normalizeTriggerIds([a, b, a.toLowerCase()])).toEqual([
      b,
      a.toLowerCase(),
    ]);
    const ids = (n: number) =>
      Array.from(
        { length: n },
        (_, i) => `0b7d1c2e-0000-4000-8000-${String(i).padStart(12, '0')}`,
      );
    expect(triggerIdsError(ids(50))).toBeNull();
    // Repetidos no cuentan dos veces.
    expect(triggerIdsError([...ids(50), ...ids(50)])).toBeNull();
    expect(triggerIdsError(ids(51))).toBe(RECALL_TYPE_TRIGGERS_MAX_MESSAGE);
  });

  it('D20: solo se enlaza un tipo de cita vivo y activo de la clínica (422)', () => {
    expect(
      recallAppointmentTypeError({ active: true, deletedAt: null }),
    ).toBeNull();
    // Inexistente o de otra clínica (bajo RLS no aparece).
    expect(recallAppointmentTypeError(null)).toBe(
      RECALL_APPOINTMENT_TYPE_INVALID_MESSAGE,
    );
    expect(recallAppointmentTypeError({ active: false, deletedAt: null })).toBe(
      RECALL_APPOINTMENT_TYPE_INVALID_MESSAGE,
    );
    expect(
      recallAppointmentTypeError({ active: true, deletedAt: new Date() }),
    ).toBe(RECALL_APPOINTMENT_TYPE_INVALID_MESSAGE);
  });
});
