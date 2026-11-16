import {
  appointmentOnHolidayMessage,
  holidayDuring,
  holidayOn,
} from './holiday-rules';

/**
 * DX-263-bis: la regla de «¿la cita cae en un festivo de la sede?», en la zona
 * de la sede. Caracas es UTC−4 todo el año: las 20:00 de la tarde ya son el
 * día siguiente en UTC.
 */
const CARACAS = 'America/Caracas';
const holidays = [
  { date: '2027-01-01', name: 'Año Nuevo', recurring: true },
  { date: '2027-02-08', name: 'Carnaval', recurring: false },
];

describe('holidayOn', () => {
  it('el recurrente vale cada año por mes y día; el puntual, solo su fecha', () => {
    expect(holidayOn('2027-01-01', holidays)?.name).toBe('Año Nuevo');
    expect(holidayOn('2031-01-01', holidays)?.name).toBe('Año Nuevo');
    expect(holidayOn('2027-02-08', holidays)?.name).toBe('Carnaval');
    expect(holidayOn('2028-02-08', holidays)).toBeNull();
    expect(holidayOn('2027-01-02', holidays)).toBeNull();
  });

  it('sin festivos, ninguno', () => {
    expect(holidayOn('2027-01-01', [])).toBeNull();
  });
});

describe('holidayDuring (America/Caracas)', () => {
  it('una cita de un festivo en la hora de Caracas lo toca, con su día civil', () => {
    // 10:00–10:30 del 8 de febrero en Caracas = 14:00Z.
    expect(
      holidayDuring(
        new Date('2027-02-08T14:00:00Z'),
        new Date('2027-02-08T14:30:00Z'),
        CARACAS,
        holidays,
      ),
    ).toEqual({ ...holidays[1], day: '2027-02-08' });
  });

  it('borde de medianoche: las 23:30 del 31 de diciembre en Caracas no son festivo aunque en UTC ya sea 1 de enero', () => {
    // 23:30–23:59 del 31/12 en Caracas = 03:30Z–03:59Z del 1/1.
    expect(
      holidayDuring(
        new Date('2027-01-01T03:30:00Z'),
        new Date('2027-01-01T03:59:00Z'),
        CARACAS,
        holidays,
      ),
    ).toBeNull();
  });

  it('borde de medianoche: las 00:00 del 1 de enero en Caracas (04:00Z) ya son festivo', () => {
    expect(
      holidayDuring(
        new Date('2027-01-01T04:00:00Z'),
        new Date('2027-01-01T04:30:00Z'),
        CARACAS,
        holidays,
      )?.name,
    ).toBe('Año Nuevo');
  });

  it('el fin es abierto: terminar justo a las 00:00 del festivo no lo toca', () => {
    expect(
      holidayDuring(
        new Date('2027-01-01T03:30:00Z'),
        new Date('2027-01-01T04:00:00Z'),
        CARACAS,
        holidays,
      ),
    ).toBeNull();
  });

  it('una cita que cruza la medianoche hacia el festivo lo toca', () => {
    expect(
      holidayDuring(
        new Date('2027-01-01T03:30:00Z'),
        new Date('2027-01-01T04:01:00Z'),
        CARACAS,
        holidays,
      )?.day,
    ).toBe('2027-01-01');
  });

  it('la misma hora UTC en otra zona es otro día civil', () => {
    // 03:30Z del 1/1 en Madrid son las 04:30 del 1/1: festivo.
    expect(
      holidayDuring(
        new Date('2027-01-01T03:30:00Z'),
        new Date('2027-01-01T03:59:00Z'),
        'Europe/Madrid',
        holidays,
      )?.name,
    ).toBe('Año Nuevo');
  });

  it('sin festivos no mira nada', () => {
    expect(
      holidayDuring(
        new Date('2027-01-01T14:00:00Z'),
        new Date('2027-01-01T14:30:00Z'),
        CARACAS,
        [],
      ),
    ).toBeNull();
  });
});

describe('appointmentOnHolidayMessage', () => {
  it('nombra el festivo, en español', () => {
    expect(appointmentOnHolidayMessage('Carnaval')).toBe(
      'Ese día la sede está cerrada por festivo («Carnaval»): elige otro día.',
    );
  });
});
