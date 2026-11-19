import { cleanSourceName, LEAD_CHANNEL_SOURCE_KEY } from './patient-source';

describe('fuentes de captación (DX-172)', () => {
  it('el nombre se recorta, colapsa espacios y mide entre 2 y 60', () => {
    expect(cleanSourceName('  Radio   local ')).toBe('Radio local');
    expect(cleanSourceName('a')).toBeNull();
    expect(cleanSourceName('x'.repeat(61))).toBeNull();
    expect(cleanSourceName('x'.repeat(60))).toBe('x'.repeat(60));
  });

  it('cada canal de prospecto tiene su decisión; los medios de contacto, sin fuente', () => {
    expect(LEAD_CHANNEL_SOURCE_KEY).toEqual({
      INSTAGRAM: 'INSTAGRAM',
      FACEBOOK: 'FACEBOOK',
      WALK_IN: 'WALK_IN',
      REFERRAL: 'PATIENT_REFERRAL',
      OTHER: 'OTHER',
      WHATSAPP: null,
      PHONE: null,
      WEBSITE: null,
    });
  });
});
