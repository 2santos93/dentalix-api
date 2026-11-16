import {
  FINANCIAL_LOCK_MESSAGES,
  applyFinancialLockPatch,
} from './financial-lock-settings';
import type { FinancialLockSettings } from './financial-lock';

const CURRENT: FinancialLockSettings = {
  lockDate: '2026-08-31',
  lockDays: null,
  adminExempt: false,
};
const TODAY = '2026-10-20';

describe('DX-091 · cambio del cierre contable', () => {
  it('ausente no cambia; null quita ese cierre', () => {
    expect(applyFinancialLockPatch(CURRENT, {}, TODAY)).toEqual({
      ok: true,
      next: CURRENT,
    });
    expect(
      applyFinancialLockPatch(CURRENT, { lockDate: null, lockDays: 7 }, TODAY),
    ).toEqual({
      ok: true,
      next: { lockDate: null, lockDays: 7, adminExempt: false },
    });
  });

  it('acepta una fecha anterior a hoy y la exención', () => {
    expect(
      applyFinancialLockPatch(
        CURRENT,
        { lockDate: '2026-09-30', adminExempt: true },
        TODAY,
      ),
    ).toEqual({
      ok: true,
      next: { lockDate: '2026-09-30', lockDays: null, adminExempt: true },
    });
  });

  it.each(['2026-10-20', '2026-10-21'])(
    'rechaza cerrar hoy o el futuro (%s)',
    (lockDate) => {
      expect(applyFinancialLockPatch(CURRENT, { lockDate }, TODAY)).toEqual({
        ok: false,
        message: FINANCIAL_LOCK_MESSAGES.lockDateNotPast,
      });
    },
  );

  it.each(['2026-02-30', '30/09/2026', 'ayer'])(
    'rechaza una fecha que no es un día civil (%s)',
    (lockDate) => {
      expect(applyFinancialLockPatch(CURRENT, { lockDate }, TODAY)).toEqual({
        ok: false,
        message: FINANCIAL_LOCK_MESSAGES.lockDate,
      });
    },
  );

  it.each([-1, 366, 2.5])('rechaza %p días', (lockDays) => {
    expect(applyFinancialLockPatch(CURRENT, { lockDays }, TODAY)).toEqual({
      ok: false,
      message: FINANCIAL_LOCK_MESSAGES.lockDays,
    });
  });

  it('admite 0 y 365 días', () => {
    for (const lockDays of [0, 365]) {
      expect(applyFinancialLockPatch(CURRENT, { lockDays }, TODAY).ok).toBe(
        true,
      );
    }
  });
});
