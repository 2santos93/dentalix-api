import {
  declaredLooksLikeProof,
  declaredMatchesDetected,
  pendingProofKey,
  proofPolicyError,
  proofStorageKey,
  sniffProofFrom,
  PROOF_NOT_ALLOWED_MESSAGE,
  PROOF_REQUIRED_MESSAGE,
} from './payment-proof';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ATTEMPT = '22222222-2222-4222-8222-222222222222';
const SHA = 'a'.repeat(64);

const source = (bytes: Buffer) => ({
  size: bytes.length,
  read: (s: number, e: number) => Promise.resolve(bytes.subarray(s, e)),
});

function png(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 13]),
    Buffer.from('IHDR', 'latin1'),
    Buffer.alloc(20),
  ]);
}

function webp(): Buffer {
  return Buffer.concat([
    Buffer.from('RIFF', 'latin1'),
    Buffer.from([0x24, 0, 0, 0]),
    Buffer.from('WEBPVP8 ', 'latin1'),
    Buffer.alloc(20),
  ]);
}

describe('sniffProofFrom (por contenido)', () => {
  it('reconoce PDF, JPG, PNG y WebP', async () => {
    expect(await sniffProofFrom(source(Buffer.from('%PDF-1.7\n')))).toBe(
      'application/pdf',
    );
    expect(
      await sniffProofFrom(source(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))),
    ).toBe('image/jpeg');
    expect(await sniffProofFrom(source(png()))).toBe('image/png');
    expect(await sniffProofFrom(source(webp()))).toBe('image/webp');
  });

  it('rechaza lo que no es de la lista blanca aunque se reconozca', async () => {
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from('ftypheic', 'latin1'),
      Buffer.alloc(20),
    ]);
    expect(await sniffProofFrom(source(heic))).toBeNull();
    expect(
      await sniffProofFrom(source(Buffer.from('<svg xmlns=""></svg>'))),
    ).toBeNull();
    expect(await sniffProofFrom(source(Buffer.from('hola mundo')))).toBeNull();
  });

  it('un RIFF que no es WEBP (p. ej. WAV) no vale', async () => {
    const wav = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.from([0x24, 0, 0, 0]),
      Buffer.from('WAVEfmt ', 'latin1'),
      Buffer.alloc(20),
    ]);
    expect(await sniffProofFrom(source(wav))).toBeNull();
  });
});

describe('proofPolicyError', () => {
  it('REQUIRED sin comprobante y NONE con comprobante fallan en español', () => {
    expect(proofPolicyError('REQUIRED', false)).toBe(PROOF_REQUIRED_MESSAGE);
    expect(proofPolicyError('NONE', true)).toBe(PROOF_NOT_ALLOWED_MESSAGE);
  });
  it('el resto pasa', () => {
    expect(proofPolicyError('REQUIRED', true)).toBeNull();
    expect(proofPolicyError('OPTIONAL', true)).toBeNull();
    expect(proofPolicyError('OPTIONAL', false)).toBeNull();
    expect(proofPolicyError('NONE', false)).toBeNull();
  });
});

describe('claves del almacén', () => {
  it('la definitiva solo lleva ids, huella y extensión (sin datos del paciente)', () => {
    expect(proofStorageKey(TENANT, ATTEMPT, 'image/webp', SHA)).toBe(
      `payment-proofs/${TENANT}/${ATTEMPT}-aaaaaaaaaaaaaaaa.webp`,
    );
  });
  it('la pendiente cuelga de pending/<tenant>', () => {
    expect(pendingProofKey(TENANT, ATTEMPT)).toBe(
      `payment-proofs/pending/${TENANT}/${ATTEMPT}`,
    );
  });
  it('rechaza ids que no son uuid', () => {
    expect(() => pendingProofKey('../x', ATTEMPT)).toThrow();
    expect(() => proofStorageKey(TENANT, ATTEMPT, 'image/png', 'zz')).toThrow();
  });
});

describe('lo declarado', () => {
  it('admite las cuatro etiquetas y las genéricas; rechaza HEIC y SVG', () => {
    for (const mimeType of [
      'image/webp',
      'image/png',
      'image/jpeg',
      'application/pdf',
      'application/octet-stream',
      '',
    ]) {
      expect(declaredLooksLikeProof({ mimeType, name: 'captura' })).toBe(true);
    }
    expect(declaredLooksLikeProof({ mimeType: 'image/heic' })).toBe(false);
    expect(declaredLooksLikeProof({ mimeType: 'image/svg+xml' })).toBe(false);
    expect(declaredLooksLikeProof({ mimeType: '', name: 'x.heic' })).toBe(
      false,
    );
  });
  it('un PNG llamado .pdf no cuadra con lo detectado', () => {
    expect(
      declaredMatchesDetected(
        { mimeType: 'image/png', name: 'a.png' },
        'image/png',
      ),
    ).toBe(true);
    expect(
      declaredMatchesDetected({ mimeType: '', name: 'a.pdf' }, 'image/png'),
    ).toBe(false);
    expect(
      declaredMatchesDetected({ mimeType: 'image/jpeg' }, 'image/webp'),
    ).toBe(false);
  });
});
