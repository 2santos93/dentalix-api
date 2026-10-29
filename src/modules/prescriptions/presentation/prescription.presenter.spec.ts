import type { PrescriptionIssuerView } from '../application/use-cases/prescriptions.use-cases';
import { presentIssuer } from './prescription.presenter';

const view = (
  phase1: PrescriptionIssuerView['phase1'],
): PrescriptionIssuerView => ({
  locationId: '00000000-0000-4000-8000-0000000000a1',
  locationName: 'Sede Principal',
  locationAddress: 'Avenida Central 100',
  clinicName: 'Clínica Demo',
  professionalName: 'Dra. Laura Ruiz',
  professionalLicense: 'RM-12345',
  professionalSpecialty: null,
  validityDays: 30,
  maxItems: 10,
  printQuantityInWords: true,
  requireClinicalRecordNumber: true,
  phase1,
});

describe('presentIssuer (fase 1, spec §4.4, §7)', () => {
  it('re-sends the legacy country of the location as the deprecated `country` and drops the phase-1 block', () => {
    const { phase1, ...rest } = view({ country: 'ES' });
    expect(phase1).toEqual({ country: 'ES' });
    expect(presentIssuer(view({ country: 'ES' }))).toEqual({
      ...rest,
      country: 'ES',
    });
    expect('phase1' in presentIssuer(view({ country: 'CO' }))).toBe(false);
  });

  it('satisfies the issuer shape the pre-DX-324 web reads (its `PrescriptionIssuerDto`)', () => {
    // Campos del `PrescriptionIssuerDto` que la web de main (6ca1667) tipa en
    // su `schema.d.ts`; pinta `${locationName} (${COUNTRY_LABELS[country]})`,
    // así que `country` debe ser una clave de su tabla, nunca `undefined`.
    const OLD_WEB_COUNTRIES = ['CO', 'ES'];
    for (const value of ['CO', 'ES'] as const) {
      const dto = presentIssuer(view({ country: value }));
      expect(OLD_WEB_COUNTRIES).toContain(dto.country);
      expect({
        locationId: typeof dto.locationId,
        locationName: typeof dto.locationName,
        locationAddress: typeof dto.locationAddress,
        clinicName: typeof dto.clinicName,
        professionalName: typeof dto.professionalName,
        professionalLicense: typeof dto.professionalLicense,
        validityDays: typeof dto.validityDays,
        maxItems: typeof dto.maxItems,
      }).toEqual({
        locationId: 'string',
        locationName: 'string',
        locationAddress: 'string',
        clinicName: 'string',
        professionalName: 'string',
        professionalLicense: 'string',
        validityDays: 'number',
        maxItems: 'number',
      });
    }
  });
});
