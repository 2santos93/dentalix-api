import {
  computeConsentHash,
  computeCountersignatureHash,
  computeRemoteConsentHash,
  type ConsentHashInput,
  type CountersignatureHashInput,
  type RemoteConsentHashInput,
} from './consent-hash';

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

const remote: RemoteConsentHashInput = {
  title: 'Consentimiento de exodoncia',
  body: 'Yo, Ana Pérez, autorizo…',
  templateVersion: 3,
  signerType: 'GUARDIAN',
  signerName: 'Claudia Navarro',
  signerDocument: 'Cédula C01',
  professionalName: 'Dra. Laura',
  patientSignature: 'iVBORw0KGgoAAA',
  signedAt: new Date('2026-10-30T15:00:00.000Z'),
  channel: 'EMAIL',
  destinationMasked: 'cl***@example.com',
  sentAt: new Date('2026-10-30T12:00:00.000Z'),
  openedAt: new Date('2026-10-30T14:00:00.000Z'),
  verifiedAt: new Date('2026-10-30T14:01:00.000Z'),
  ipAddress: '203.0.113.7',
  userAgent: 'Mozilla/5.0',
};

describe('computeRemoteConsentHash (DX-243)', () => {
  it('es un SHA-256 en hex, determinista y distinto del de una firma en pantalla', () => {
    const hash = computeRemoteConsentHash(remote);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computeRemoteConsentHash({ ...remote })).toBe(hash);
    expect(hash).not.toBe(
      computeConsentHash({ ...base, ...remote, professionalSignature: '' }),
    );
  });

  it.each<[keyof RemoteConsentHashInput, unknown]>([
    ['title', 'Otro título'],
    ['body', 'Yo, Ana Pérez, NO autorizo…'],
    ['templateVersion', 4],
    ['signerType', 'PATIENT'],
    ['signerName', 'Otra persona'],
    ['signerDocument', null],
    ['professionalName', 'Otro profesional'],
    ['patientSignature', 'iVBORw0KGgoXXX'],
    ['signedAt', new Date('2026-10-30T15:00:01.000Z')],
    ['destinationMasked', 'an***@example.com'],
    ['sentAt', new Date('2026-10-30T12:00:01.000Z')],
    ['openedAt', new Date('2026-10-30T14:00:01.000Z')],
    ['verifiedAt', new Date('2026-10-30T14:01:01.000Z')],
    ['ipAddress', '203.0.113.8'],
    ['userAgent', null],
  ])('cambia si cambia %s', (field, value) => {
    expect(computeRemoteConsentHash({ ...remote, [field]: value })).not.toBe(
      computeRemoteConsentHash(remote),
    );
  });
});

describe('computeCountersignatureHash (DX-243)', () => {
  const input: CountersignatureHashInput = {
    consentHash: 'a'.repeat(64),
    professionalName: 'Dra. Laura',
    professionalSignature: 'iVBORw0KGgoBBB',
    signedAt: new Date('2026-10-30T16:00:00.000Z'),
  };

  it.each<[keyof CountersignatureHashInput, unknown]>([
    ['consentHash', 'b'.repeat(64)],
    ['professionalName', 'Otro'],
    ['professionalSignature', 'iVBORw0KGgoZZZ'],
    ['signedAt', new Date('2026-10-30T16:00:01.000Z')],
  ])(
    'encadena el hash del consentimiento; cambia si cambia %s',
    (field, value) => {
      const hash = computeCountersignatureHash(input);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
      expect(
        computeCountersignatureHash({ ...input, [field]: value }),
      ).not.toBe(hash);
    },
  );
});
