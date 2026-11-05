import {
  entryCivilDay,
  isAppointmentDay,
  isFutureEntryDate,
} from './entry-date-rules';

const CARACAS = 'America/Caracas'; // UTC-4 todo el año

describe('entry-date-rules (DX-231)', () => {
  describe('entryCivilDay', () => {
    it('lee la medianoche UTC como el día civil elegido', () => {
      expect(entryCivilDay(new Date('2026-10-20T00:00:00.000Z'), CARACAS)).toBe(
        '2026-10-20',
      );
    });

    it('lee un instante con hora en la zona de la sede', () => {
      // 22:00 en Caracas = 02:00 UTC del día siguiente
      expect(entryCivilDay(new Date('2026-10-21T02:00:00.000Z'), CARACAS)).toBe(
        '2026-10-20',
      );
    });
  });

  describe('isAppointmentDay', () => {
    const start = new Date('2026-10-21T01:30:00.000Z'); // 21:30 del 20 en Caracas

    it('acepta el día de la cita en la zona de su sede', () => {
      expect(
        isAppointmentDay(new Date('2026-10-20T00:00:00.000Z'), start, CARACAS),
      ).toBe(true);
    });

    it('rechaza otro día', () => {
      expect(
        isAppointmentDay(new Date('2026-10-21T00:00:00.000Z'), start, CARACAS),
      ).toBe(false);
      expect(
        isAppointmentDay(new Date('2026-10-19T00:00:00.000Z'), start, CARACAS),
      ).toBe(false);
    });
  });

  describe('isFutureEntryDate', () => {
    // 21:00 del 20 de octubre en Caracas = 01:00 UTC del 21
    const now = new Date('2026-10-21T01:00:00.000Z');

    it('hoy en la sede no es futuro aunque en UTC ya sea mañana', () => {
      expect(
        isFutureEntryDate(new Date('2026-10-20T00:00:00.000Z'), now, CARACAS),
      ).toBe(false);
    });

    it('un día después de hoy en la sede es futuro', () => {
      expect(
        isFutureEntryDate(new Date('2026-10-21T00:00:00.000Z'), now, CARACAS),
      ).toBe(true);
    });

    it('un día pasado no es futuro', () => {
      expect(
        isFutureEntryDate(new Date('2025-01-15T10:00:00.000Z'), now, CARACAS),
      ).toBe(false);
    });
  });
});
