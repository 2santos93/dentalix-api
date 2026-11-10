import {
  buildAppointmentIcs,
  calendarUid,
  escapeIcsText,
  foldIcsLine,
  googleCalendarUrl,
  icsUtc,
  type AppointmentCalendarEvent,
} from './appointment-calendar';

const EVENT: AppointmentCalendarEvent = {
  tenantId: 'tenant-1',
  appointmentId: 'appointment-sentinel-1',
  // 10:00–10:30 en Caracas (UTC−4).
  start: new Date('2026-11-20T14:00:00.000Z'),
  end: new Date('2026-11-20T14:30:00.000Z'),
  updatedAt: new Date('2026-11-01T12:00:00.000Z'),
  cancelled: false,
  clinicName: 'Clínica Sonrisa',
  providerName: 'Dra. Pérez',
  locationName: 'Sede Norte',
  locationAddress: 'Av. Libertador 100, Caracas',
  alarmHours: 24,
};

const lines = (ics: string) => ics.replace(/\r\n /g, '').split('\r\n');

describe('calendario de la cita (DX-469)', () => {
  it('VCALENDAR con un VEVENT: horas en UTC, título con clínica y profesional, lugar y alarma de 24 h', () => {
    const ics = buildAppointmentIcs(EVENT);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics).not.toMatch(/[^\r]\n/);
    const l = lines(ics);
    expect(l[0]).toBe('BEGIN:VCALENDAR');
    expect(l).toContain('VERSION:2.0');
    expect(l).toContain('DTSTART:20261120T140000Z');
    expect(l).toContain('DTEND:20261120T143000Z');
    expect(l).toContain('SUMMARY:Cita en Clínica Sonrisa con Dra. Pérez');
    expect(l).toContain('LOCATION:Sede Norte\\, Av. Libertador 100\\, Caracas');
    expect(l).toContain('STATUS:CONFIRMED');
    expect(l).toContain('TRIGGER:-PT24H');
    expect(l.at(-2)).toBe('END:VCALENDAR');
  });

  it('nada clínico ni el id de la cita: el UID es un hash estable', () => {
    const ics = buildAppointmentIcs(EVENT);
    expect(ics).not.toContain('appointment-sentinel-1');
    expect(calendarUid('tenant-1', 'appointment-sentinel-1')).toBe(
      calendarUid('tenant-1', 'appointment-sentinel-1'),
    );
    expect(calendarUid('tenant-1', 'a')).not.toBe(calendarUid('tenant-2', 'a'));
    expect(lines(ics)).toContain(
      `UID:${calendarUid('tenant-1', 'appointment-sentinel-1')}`,
    );
  });

  it('reprogramar: mismo UID y SEQUENCE mayor; cancelada: STATUS:CANCELLED y sin alarma', () => {
    const seq = (ics: string) =>
      Number(
        lines(ics)
          .find((l) => l.startsWith('SEQUENCE:'))!
          .slice(9),
      );
    const moved = buildAppointmentIcs({
      ...EVENT,
      start: new Date('2026-11-21T14:00:00.000Z'),
      updatedAt: new Date('2026-11-02T12:00:00.000Z'),
    });
    expect(seq(moved)).toBeGreaterThan(seq(buildAppointmentIcs(EVENT)));
    const cancelled = buildAppointmentIcs({ ...EVENT, cancelled: true });
    expect(lines(cancelled)).toContain('STATUS:CANCELLED');
    expect(cancelled).not.toContain('VALARM');
  });

  it('alarma 0: sin VALARM; sin profesional ni dirección, el título y el lugar se acortan', () => {
    const ics = buildAppointmentIcs({
      ...EVENT,
      alarmHours: 0,
      providerName: null,
      locationAddress: null,
    });
    expect(ics).not.toContain('VALARM');
    expect(lines(ics)).toContain('SUMMARY:Cita en Clínica Sonrisa');
    expect(lines(ics)).toContain('LOCATION:Sede Norte');
  });

  it('escapa TEXT y pliega a 75 octetos sin partir un carácter', () => {
    expect(escapeIcsText('a;b,c\\d\ne')).toBe('a\\;b\\,c\\\\d\\ne');
    const long = `SUMMARY:${'ñ'.repeat(60)}`;
    const folded = foldIcsLine(long);
    for (const part of folded.split('\r\n')) {
      expect(Buffer.byteLength(part, 'utf8')).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(long);
    expect(icsUtc(new Date('2026-01-02T03:04:05.678Z'))).toBe(
      '20260102T030405Z',
    );
  });

  it('enlace de Google Calendar con título, fechas en UTC y lugar', () => {
    const url = new URL(googleCalendarUrl(EVENT));
    expect(url.origin + url.pathname).toBe(
      'https://calendar.google.com/calendar/render',
    );
    expect(url.searchParams.get('action')).toBe('TEMPLATE');
    expect(url.searchParams.get('text')).toBe(
      'Cita en Clínica Sonrisa con Dra. Pérez',
    );
    expect(url.searchParams.get('dates')).toBe(
      '20261120T140000Z/20261120T143000Z',
    );
    expect(url.searchParams.get('location')).toBe(
      'Sede Norte, Av. Libertador 100, Caracas',
    );
  });
});
