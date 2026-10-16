import { computeConsentHash, type ConsentHashInput } from './consent-hash';

const base: ConsentHashInput = {
  title: 'Consentimiento de exodoncia',
  body: 'Yo, Ana Pérez, autorizo…',
  signerType: 'PATIENT',
  signerName: 'Ana Pérez',
  signerDocument: 'CC 1',
  professionalName: 'Dra. Laura',
  patientSignature: 'iVBORw0KGgoAAA',
  professionalSignature: 'iVBORw0KGgoBBB',
  signedAt: new Date('2026-10-16T15:00:00.000Z'),
};

describe('computeConsentHash', () => {
  it('es un SHA-256 en hex, determinista', () => {
    const hash = computeConsentHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeConsentHash({ ...base })).toBe(hash);
  });

  it.each<[keyof ConsentHashInput, unknown]>([
    ['title', 'Otro título'],
    ['body', 'Yo, Ana Pérez, NO autorizo…'],
    ['signerType', 'GUARDIAN'],
    ['signerName', 'Otra persona'],
    ['signerDocument', 'CC 2'],
    ['professionalName', 'Otro profesional'],
    ['patientSignature', 'iVBORw0KGgoXXX'],
    ['professionalSignature', 'iVBORw0KGgoYYY'],
    ['signedAt', new Date('2026-10-16T15:00:01.000Z')],
  ])('cambia si cambia %s', (field, value) => {
    expect(computeConsentHash({ ...base, [field]: value })).not.toBe(
      computeConsentHash(base),
    );
  });

  it('no confunde campos al concatenar (sin colisión por fronteras)', () => {
    expect(computeConsentHash({ ...base, title: 'ab', body: 'c' })).not.toBe(
      computeConsentHash({ ...base, title: 'a', body: 'bc' }),
    );
  });
});
