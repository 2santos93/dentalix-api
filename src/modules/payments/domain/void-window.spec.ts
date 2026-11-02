import { ClinicRole } from '@prisma/client';
import {
  canVoidPayment,
  civilDateIn,
  isSameCivilDay,
  voidDenial,
} from './void-window';

describe('void window', () => {
  it('formatea el día civil en la zona dada', () => {
    const instant = new Date('2026-10-16T02:00:00.000Z');
    expect(civilDateIn(instant, 'UTC')).toBe('2026-10-16');
    expect(civilDateIn(instant, 'America/Bogota')).toBe('2026-10-15');
  });

  it('compara días de la sede, no días UTC', () => {
    const a = new Date('2026-10-16T04:59:00.000Z'); // 23:59 del 15 en la zona de la sede
    const b = new Date('2026-10-16T05:00:00.000Z'); // 00:00 del 16 en la zona de la sede
    expect(isSameCivilDay(a, b, 'UTC')).toBe(true);
    expect(isSameCivilDay(a, b, 'America/Bogota')).toBe(false);
  });
});

describe('voidDenial / canVoidPayment (regla de anulación, DX-057)', () => {
  // 2026-10-16 10:00 en la zona de la sede (UTC-5).
  const NOW = new Date('2026-10-16T15:00:00.000Z');
  const RECEPTION = { userId: 'u-recep', role: ClinicRole.RECEPTION };
  const ADMIN = { userId: 'u-admin', role: ClinicRole.ADMIN };
  const ownToday = {
    createdById: 'u-recep',
    createdAt: new Date('2026-10-16T13:00:00.000Z'),
    timeZone: 'America/Bogota',
  };

  it('recepción puede anular un abono suyo registrado hoy en la sede', () => {
    expect(voidDenial(ownToday, RECEPTION, NOW)).toBeNull();
    expect(canVoidPayment(ownToday, RECEPTION, NOW)).toBe(true);
  });

  it('recepción no puede anular el abono de otro usuario (ni uno sin autor)', () => {
    const other = { ...ownToday, createdById: 'u-otra' };
    const legacy = { ...ownToday, createdById: null };
    expect(voidDenial(other, RECEPTION, NOW)).toBe('NOT_AUTHOR');
    expect(voidDenial(legacy, RECEPTION, NOW)).toBe('NOT_AUTHOR');
    expect(canVoidPayment(other, RECEPTION, NOW)).toBe(false);
  });

  it('recepción no puede anular un abono suyo de otro día de la sede', () => {
    // 23:30 del 15 en la zona de la sede: ya es 16 en UTC, pero no "hoy" en la sede.
    const yesterday = {
      ...ownToday,
      createdAt: new Date('2026-10-16T04:30:00.000Z'),
    };
    expect(voidDenial(yesterday, RECEPTION, NOW)).toBe('NOT_SAME_DAY');
    expect(canVoidPayment(yesterday, RECEPTION, NOW)).toBe(false);
    expect(
      canVoidPayment({ ...yesterday, timeZone: 'UTC' }, RECEPTION, NOW),
    ).toBe(true);
  });

  it('ADMIN anula cualquiera: de otro usuario, sin autor o de otro día', () => {
    expect(
      canVoidPayment(
        {
          createdById: null,
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
          timeZone: 'America/Bogota',
        },
        ADMIN,
        NOW,
      ),
    ).toBe(true);
  });
});
