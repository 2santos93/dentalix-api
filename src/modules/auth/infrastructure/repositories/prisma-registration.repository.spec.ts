import { locationOf } from './prisma-registration.repository';

const ROW = {
  id: 'p-1',
  email: 'owner@clinic.test',
  clinicName: 'Clínica',
  subdomain: 'clinica',
  fullName: 'Dra. Dueña',
  passwordHash: '$argon2id$v=19$fake',
  expiresAt: new Date('2026-10-28'),
};

describe('locationOf (G1-B, pre-flight I3)', () => {
  it('a pending row with four fields and no clock is not legacy', () => {
    // Un pendiente de la web de G1: si fuera legado, la función D5 de G1
    // pisaría la moneda, la zona y el formato que eligió la persona.
    expect(
      locationOf({
        ...ROW,
        locationCountry: 'CO',
        locationCurrency: 'EUR',
        locationTimeZone: 'Europe/Berlin',
        locationLocale: 'de-DE',
        locationHourCycle: null,
      }),
    ).toEqual({
      country: 'CO',
      currency: 'EUR',
      timeZone: 'Europe/Berlin',
      locale: 'de-DE',
      hourCycle: null,
    });
  });

  it('con los cinco devuelve el reloj elegido', () => {
    expect(
      locationOf({
        ...ROW,
        locationCountry: 'CO',
        locationCurrency: 'USD',
        locationTimeZone: 'America/New_York',
        locationLocale: 'en-US',
        locationHourCycle: 'h12',
      }),
    ).toMatchObject({ locale: 'en-US', hourCycle: 'h12' });
  });

  it('sin los cuatro de G1 es legado aunque traiga reloj', () => {
    expect(
      locationOf({
        ...ROW,
        locationCountry: null,
        locationCurrency: null,
        locationTimeZone: null,
        locationLocale: null,
        locationHourCycle: 'h23',
      }),
    ).toBeNull();
  });
});
