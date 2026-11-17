import {
  closeBlocker,
  lockDateAfterSettlement,
  parseSettlementPeriod,
  SETTLEMENT_PERIOD_MESSAGES,
} from './settlement-period';

describe('período de la liquidación (DX-018)', () => {
  it('valida las fechas y el tope de 366 días', () => {
    expect(parseSettlementPeriod('2026-10-01', '2026-10-31')).toEqual({
      ok: true,
      period: { from: '2026-10-01', to: '2026-10-31' },
    });
    expect(parseSettlementPeriod('2026-10-31', '2026-10-01')).toEqual({
      ok: false,
      message: SETTLEMENT_PERIOD_MESSAGES.invalid,
    });
    expect(parseSettlementPeriod('2026-02-30', '2026-03-01').ok).toBe(false);
    expect(parseSettlementPeriod('2025-01-01', '2026-10-31')).toEqual({
      ok: false,
      message: SETTLEMENT_PERIOD_MESSAGES.tooLong,
    });
  });

  const ctx = {
    period: { from: '2026-10-01', to: '2026-10-31' },
    today: '2026-11-05',
    lastClosedTo: '2026-09-30',
    overlaps: false,
    rule: { active: true },
  };

  it('se cierra un período terminado y seguido a la última liquidación', () => {
    expect(closeBlocker(ctx)).toBeNull();
    expect(closeBlocker({ ...ctx, lastClosedTo: null })).toBeNull();
  });

  it('dice por qué no se puede cerrar', () => {
    expect(closeBlocker({ ...ctx, rule: null })).toBe('NO_RULE');
    expect(closeBlocker({ ...ctx, rule: { active: false } })).toBe(
      'RULE_INACTIVE',
    );
    expect(closeBlocker({ ...ctx, today: '2026-10-31' })).toBe(
      'PERIOD_NOT_ENDED',
    );
    expect(closeBlocker({ ...ctx, overlaps: true })).toBe('OVERLAPS_PREVIOUS');
    expect(closeBlocker({ ...ctx, lastClosedTo: '2026-10-15' })).toBe(
      'OVERLAPS_PREVIOUS',
    );
    expect(closeBlocker({ ...ctx, lastClosedTo: '2026-09-15' })).toBe(
      'GAP_AFTER_PREVIOUS',
    );
  });

  it('el cierre contable sube hasta el «hasta» y nunca retrocede', () => {
    expect(lockDateAfterSettlement(null, '2026-10-31')).toBe('2026-10-31');
    expect(lockDateAfterSettlement('2026-09-30', '2026-10-31')).toBe(
      '2026-10-31',
    );
    expect(lockDateAfterSettlement('2026-11-02', '2026-10-31')).toBe(
      '2026-11-02',
    );
  });
});
