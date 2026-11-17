import { BadRequestException, ConflictException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  LOCK_OVERRIDE_REASON_REQUIRED_MESSAGE,
  PERIOD_LOCKED_MESSAGES,
  assertLockDecision,
  decideLock,
  isCivilDayLocked,
  lockedThrough,
  lockedThroughAt,
  mayOverrideLock,
  periodLockedException,
  voidLockState,
  type FinancialLockSettings,
} from './financial-lock';

const CARACAS = 'America/Caracas';
const NONE: FinancialLockSettings = {
  lockDate: null,
  lockDays: null,
  adminExempt: false,
};
const ADMIN = { userId: 'u-admin', role: ClinicRole.ADMIN };
const RECEPTION = { userId: 'u-rec', role: ClinicRole.RECEPTION };

describe('DX-091 · cierre contable (dominio)', () => {
  describe('lockedThrough: el cierre más restrictivo', () => {
    it('sin ajustes no hay cierre', () => {
      expect(lockedThrough(NONE, '2026-10-20')).toBeNull();
    });

    it('fecha fija: cerrado ese día y lo anterior', () => {
      const s = { ...NONE, lockDate: '2026-09-30' };
      expect(lockedThrough(s, '2026-10-20')).toBe('2026-09-30');
      expect(isCivilDayLocked('2026-09-15', '2026-09-30')).toBe(true);
      expect(isCivilDayLocked('2026-09-30', '2026-09-30')).toBe(true);
      expect(isCivilDayLocked('2026-10-01', '2026-09-30')).toBe(false);
    });

    it('días: con 7 quedan abiertos hoy y los 7 anteriores', () => {
      const s = { ...NONE, lockDays: 7 };
      // Hoy 20/10: abiertos del 13 al 20; cerrado hasta el 12.
      expect(lockedThrough(s, '2026-10-20')).toBe('2026-10-12');
      expect(lockedThrough({ ...NONE, lockDays: 0 }, '2026-10-20')).toBe(
        '2026-10-19',
      );
      // Cruza meses y años.
      expect(lockedThrough(s, '2027-01-03')).toBe('2026-12-26');
    });

    it('con días = 7 y una fecha fija más antigua rige el de los días (reloj inyectado)', () => {
      const s = { ...NONE, lockDate: '2026-09-30', lockDays: 7 };
      const now = new Date('2026-10-20T15:00:00.000Z'); // 11:00 en Caracas
      expect(lockedThroughAt(s, now, CARACAS)).toBe('2026-10-12');
    });

    it('con una fecha fija más reciente que los días, rige la fecha', () => {
      const s = { ...NONE, lockDate: '2026-10-15', lockDays: 7 };
      const now = new Date('2026-10-20T15:00:00.000Z');
      expect(lockedThroughAt(s, now, CARACAS)).toBe('2026-10-15');
    });

    it('«hoy» es el día civil de la sede, no el de UTC (cerca de medianoche en Caracas)', () => {
      const s = { ...NONE, lockDays: 0 };
      // 23:30 del 20/10 en Caracas = 03:30 UTC del 21/10.
      const lateNight = new Date('2026-10-21T03:30:00.000Z');
      expect(lockedThroughAt(s, lateNight, CARACAS)).toBe('2026-10-19');
      expect(lockedThroughAt(s, lateNight, 'UTC')).toBe('2026-10-20');
      // 00:10 del 21/10 en Caracas: ya es otro día en la sede.
      const afterMidnight = new Date('2026-10-21T04:10:00.000Z');
      expect(lockedThroughAt(s, afterMidnight, CARACAS)).toBe('2026-10-20');
    });
  });

  describe('decideLock', () => {
    const locked = { ...NONE, lockDate: '2026-09-30' };
    const exempt = { ...locked, adminExempt: true };

    it('un día abierto pasa, sea quien sea', () => {
      expect(decideLock('2026-10-01', locked, '2026-09-30', RECEPTION)).toEqual(
        { kind: 'open' },
      );
    });

    it('un día cerrado es 409 para RECEPTION aunque traiga motivo', () => {
      const decision = decideLock('2026-09-15', exempt, '2026-09-30', {
        ...RECEPTION,
        overrideReason: 'Lo pidió el paciente',
      });
      expect(decision).toEqual({ kind: 'locked', through: '2026-09-30' });
      expect(() => assertLockDecision(decision, 'PAYMENT_VOID')).toThrow(
        ConflictException,
      );
    });

    it('un día cerrado es 409 para el ADMIN si la clínica no admite la exención', () => {
      expect(
        decideLock('2026-09-15', locked, '2026-09-30', {
          ...ADMIN,
          overrideReason: 'Ajuste con el banco',
        }),
      ).toEqual({ kind: 'locked', through: '2026-09-30' });
    });

    it('con la exención, el ADMIN lo salta con motivo (recortado)', () => {
      expect(
        decideLock('2026-09-15', exempt, '2026-09-30', {
          ...ADMIN,
          overrideReason: '  Ajuste con el extracto del banco  ',
        }),
      ).toEqual({
        kind: 'override',
        through: '2026-09-30',
        reason: 'Ajuste con el extracto del banco',
      });
    });

    it.each([undefined, null, '', '  ', 'ab', 'x'.repeat(301)])(
      'con la exención, el ADMIN sin motivo válido (%p) recibe 400',
      (overrideReason) => {
        expect(() =>
          decideLock('2026-09-15', exempt, '2026-09-30', {
            ...ADMIN,
            overrideReason,
          }),
        ).toThrow(
          new BadRequestException(LOCK_OVERRIDE_REASON_REQUIRED_MESSAGE),
        );
      },
    );

    it('sin actor (p. ej. confirmar un reporte del paciente) un día cerrado es 409', () => {
      expect(decideLock('2026-09-15', exempt, '2026-09-30', null)).toEqual({
        kind: 'locked',
        through: '2026-09-30',
      });
    });

    it('mayOverrideLock: solo ADMIN y solo con la exención', () => {
      expect(mayOverrideLock(exempt, ClinicRole.ADMIN)).toBe(true);
      expect(mayOverrideLock(locked, ClinicRole.ADMIN)).toBe(false);
      expect(mayOverrideLock(exempt, ClinicRole.RECEPTION)).toBe(false);
      expect(mayOverrideLock(exempt, null)).toBe(false);
    });
  });

  it('el 409 lleva el código PERIOD_LOCKED, el mensaje en español y el último día cerrado', () => {
    const error = periodLockedException('PAYMENT_CREATE', '2026-09-30');
    expect(error.getStatus()).toBe(409);
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'PERIOD_LOCKED',
      message: PERIOD_LOCKED_MESSAGES.PAYMENT_CREATE,
      lockedThrough: '2026-09-30',
    });
  });

  describe('voidLockState (Caja y Estado de cuenta)', () => {
    const now = new Date('2026-10-20T15:00:00.000Z');
    // 15/09 al mediodía de Caracas.
    const oldPayment = new Date('2026-09-15T16:00:00.000Z');
    const recent = new Date('2026-10-05T16:00:00.000Z');
    const locked = { ...NONE, lockDate: '2026-09-30' };

    it('sin cierre no bloquea', () => {
      expect(
        voidLockState(null, oldPayment, CARACAS, now, ClinicRole.RECEPTION),
      ).toEqual({ periodLocked: false, blocksVoid: false });
    });

    it('un abono cerrado bloquea a RECEPTION y al ADMIN sin exención', () => {
      for (const role of [ClinicRole.RECEPTION, ClinicRole.ADMIN]) {
        expect(voidLockState(locked, oldPayment, CARACAS, now, role)).toEqual({
          periodLocked: true,
          blocksVoid: true,
        });
      }
    });

    it('con la exención, el ADMIN ve el abono cerrado pero puede anularlo', () => {
      expect(
        voidLockState(
          { ...locked, adminExempt: true },
          oldPayment,
          CARACAS,
          now,
          ClinicRole.ADMIN,
        ),
      ).toEqual({ periodLocked: true, blocksVoid: false });
    });

    it('un abono posterior al cierre no está cerrado', () => {
      expect(
        voidLockState(locked, recent, CARACAS, now, ClinicRole.RECEPTION),
      ).toEqual({ periodLocked: false, blocksVoid: false });
    });

    it('el día del abono es el de su sede: 30/09 a las 22:00 en Caracas sigue cerrado', () => {
      // 02:00 UTC del 01/10 = 22:00 del 30/09 en Caracas.
      const lateSept30 = new Date('2026-10-01T02:00:00.000Z');
      expect(
        voidLockState(locked, lateSept30, CARACAS, now, ClinicRole.RECEPTION)
          .periodLocked,
      ).toBe(true);
      expect(
        voidLockState(locked, lateSept30, 'UTC', now, ClinicRole.RECEPTION)
          .periodLocked,
      ).toBe(false);
    });
  });
});
