import type { ConfirmationAppointment } from '../domain/entities/appointment-confirmation.entity';
import { toPublicAppointmentView } from './public-confirmation-view';

function appointment(
  overrides: Partial<ConfirmationAppointment> = {},
): ConfirmationAppointment {
  return {
    id: 'appointment-sentinel-1',
    start: new Date('2027-03-01T14:00:00.000Z'),
    end: new Date('2027-03-01T14:30:00.000Z'),
    status: 'SCHEDULED',
    patientFirstName: 'Ana María',
    patientPhone: '+58 414 555 0101',
    providerName: 'Dra. Pérez',
    locationId: 'location-sentinel-1',
    locationName: 'Sede Este',
    locationAddress: 'Av. Principal',
    locationPhoneRegion: 'VE',
    locationTimeZone: 'America/New_York',
    locationLocale: 'en-US',
    locationHourCycle: 'h12',
    ...overrides,
  };
}

describe('toPublicAppointmentView (DX-354)', () => {
  it('lleva zona, locale y reloj de la sede de la cita, en crudo', () => {
    const view = toPublicAppointmentView(appointment());
    expect(view).toMatchObject({
      timeZone: 'America/New_York',
      locale: 'en-US',
      hourCycle: 'h12',
    });
  });

  it('sede sin reloj: los campos salen null', () => {
    const view = toPublicAppointmentView(
      appointment({
        locationTimeZone: null,
        locationLocale: null,
        locationHourCycle: null,
      }),
    );
    expect(view.timeZone).toBeNull();
    expect(view.locale).toBeNull();
    expect(view.hourCycle).toBeNull();
  });

  it('no incluye datos que no sean los permitidos', () => {
    const view = toPublicAppointmentView(appointment());
    expect(Object.keys(view).sort()).toEqual([
      'end',
      'hourCycle',
      'locale',
      'locationAddress',
      'locationName',
      'patientFirstName',
      'providerName',
      'start',
      'timeZone',
    ]);
    expect(JSON.stringify(view)).not.toMatch(
      /location-sentinel-1|appointment-sentinel-1|414 555 0101/,
    );
  });
});
