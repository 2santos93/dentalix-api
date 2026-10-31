import { regionalFormat } from '../../../shared/format/regional-format';
import {
  computeCountersignatureHash,
  computeRemoteConsentHash,
} from './consent-hash';
import {
  SignedConsentPdfSourceError,
  buildSignedConsentPdfModel,
  signedConsentPdfFileName,
  signedConsentPdfErrorCode,
  type SignedConsentPdfSource,
} from './signed-consent-pdf';

const SIG = 'iVBORw0KGgo=';

function source(
  overrides: Partial<SignedConsentPdfSource> = {},
): SignedConsentPdfSource {
  const base = {
    title: 'Consentimiento — Exodoncia',
    body: 'Yo, Laura Castro,\nautorizo la exodoncia del 38.\n\n«Riesgos»: sangrado — ¿dudas? ¡Pregunte! 1,5 € “ok”.',
    templateVersion: 3,
    signerType: 'PATIENT' as const,
    signerName: 'Laura Castro',
    signerDocument: 'V-12.345.678',
    professionalName: 'Andrés Gómez Pérez',
    patientSignature: SIG,
    signedAt: new Date('2026-10-31T18:05:12.345Z'),
    channel: 'EMAIL' as const,
    destinationMasked: 'la***@example.com',
    sentAt: new Date('2026-10-30T13:00:00.000Z'),
    openedAt: new Date('2026-10-31T17:59:00.000Z'),
    verifiedAt: new Date('2026-10-31T18:01:30.000Z'),
    ipAddress: '203.0.113.7',
    userAgent: 'Mozilla/5.0 (iPhone)',
    ...overrides,
  };
  const contentHash = computeRemoteConsentHash(base);
  const professionalSignedAt = new Date('2026-11-01T02:30:00.000Z');
  return {
    consentId: '11111111-1111-4111-8111-111111111111',
    clinicName: 'Clínica Demo',
    ...base,
    contentHash,
    professionalSignature: SIG,
    professionalSignedAt,
    countersignatureHash: computeCountersignatureHash({
      consentHash: contentHash,
      professionalName: base.professionalName,
      professionalSignature: SIG,
      signedAt: professionalSignedAt,
    }),
    location: {
      name: 'Sede Centro',
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h12',
    },
    ...overrides,
  };
}

/** Lo firmado cambiado DESPUÉS de sellar (sin recalcular los hashes). */
function tampered(
  overrides: Partial<SignedConsentPdfSource>,
): SignedConsentPdfSource {
  return { ...source(), ...overrides };
}

describe('buildSignedConsentPdfModel (DX-422)', () => {
  it('reproduce EXACTAMENTE el título y el texto congelados', () => {
    const src = source();
    const model = buildSignedConsentPdfModel(src);
    expect(model.title).toBe(src.title);
    expect(model.body).toBe(src.body);
  });

  it('la página de evidencias lleva el hash guardado, que coincide con el recalculado', () => {
    const src = source();
    const model = buildSignedConsentPdfModel(src);
    const value = (label: string) =>
      model.evidence.find((row) => row.label === label)?.value;
    expect(value('Huella SHA-256 de la firma del paciente')).toBe(
      src.contentHash,
    );
    expect(value('Huella SHA-256 de la firma del profesional')).toBe(
      src.countersignatureHash,
    );
  });

  it('lleva documento y versión, canal, destino enmascarado, IP y navegador', () => {
    const model = buildSignedConsentPdfModel(source());
    const labels = Object.fromEntries(
      model.evidence.map((row) => [row.label, row.value]),
    );
    expect(labels).toMatchObject({
      Documento: 'Consentimiento — Exodoncia',
      'Versión de la plantilla': '3',
      Canal: 'Email',
      Destino: 'la***@example.com',
      'IP de quien firmó': '203.0.113.7',
      'Navegador de quien firmó': 'Mozilla/5.0 (iPhone)',
      'Firmado por': 'Laura Castro (paciente) · V-12.345.678',
      Profesional: 'Andrés Gómez Pérez',
    });
  });

  it('cada hora va en la zona IANA de la sede con su formato, y en UTC exacto', () => {
    const src = source();
    const model = buildSignedConsentPdfModel(src);
    const fmt = regionalFormat({ locale: 'es-VE', hourCycle: 'h12' });
    const sent = model.evidence.find((row) => row.label === 'Enviado')?.value;
    expect(sent).toBe(
      `${fmt.dateTime(src.sentAt, 'America/Caracas')} (America/Caracas) · 2026-10-30T13:00:00.000Z UTC`,
    );
    for (const label of [
      'Enviado',
      'Abierto',
      'Código verificado',
      'Firmado por el paciente',
      'Firmado por el profesional',
    ]) {
      expect(model.evidence.find((row) => row.label === label)?.value).toMatch(
        /\(America\/Caracas\) · \d{4}-\d{2}-\d{2}T.*Z UTC$/,
      );
    }
    expect(model.evidence.find((r) => r.label === 'Zona horaria')?.value).toBe(
      'America/Caracas (Sede Centro)',
    );
  });

  it('la misma firma en otra sede sale con la hora de ESA zona (nada de supuestos de país)', () => {
    const tokyo = buildSignedConsentPdfModel(
      source({
        location: {
          name: 'Shibuya',
          timeZone: 'Asia/Tokyo',
          locale: 'ja-JP',
          hourCycle: 'h23',
        },
      }),
    );
    const fmt = regionalFormat({ locale: 'ja-JP', hourCycle: 'h23' });
    expect(tokyo.evidence.find((r) => r.label === 'Enviado')?.value).toBe(
      `${fmt.dateTime(new Date('2026-10-30T13:00:00.000Z'), 'Asia/Tokyo')} (Asia/Tokyo) · 2026-10-30T13:00:00.000Z UTC`,
    );
  });

  it('el responsable firma como tal y sin IP ni navegador dice «No registrado»', () => {
    const model = buildSignedConsentPdfModel(
      source({
        signerType: 'GUARDIAN',
        signerName: 'Claudia Navarro',
        signerDocument: null,
        ipAddress: null,
        userAgent: null,
      }),
    );
    const value = (label: string) =>
      model.evidence.find((row) => row.label === label)?.value;
    expect(value('Firmado por')).toBe('Claudia Navarro (responsable)');
    expect(value('Firmado por el responsable')).toMatch(/America\/Caracas/);
    expect(value('IP de quien firmó')).toBe('No registrado');
    expect(value('Navegador de quien firmó')).toBe('No registrado');
  });

  it('se niega si el hash guardado no coincide con lo firmado (no archiva un documento alterado)', () => {
    expect(() =>
      buildSignedConsentPdfModel(tampered({ body: 'Otro texto' })),
    ).toThrow(SignedConsentPdfSourceError);
    expect(() =>
      buildSignedConsentPdfModel(
        tampered({ countersignatureHash: 'a'.repeat(64) }),
      ),
    ).toThrow(SignedConsentPdfSourceError);
  });

  it('un texto que la fuente del PDF no puede pintar tal cual NO se archiva alterado', () => {
    expect(() =>
      buildSignedConsentPdfModel(source({ body: 'Paciente: 名前' })),
    ).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_CHARACTERS' }) as Error,
    );
    expect(() =>
      buildSignedConsentPdfModel(source({ signerName: 'Ζωή' })),
    ).toThrow(SignedConsentPdfSourceError);
  });

  it('B5: un tabulador o un \\r suelto no se pintan tal cual: UNSUPPORTED_CHARACTERS; \\r\\n sí vale', () => {
    for (const body of ['Uno\tdos', 'Uno\rdos', 'Fin\r']) {
      expect(() => buildSignedConsentPdfModel(source({ body }))).toThrow(
        expect.objectContaining({ code: 'UNSUPPORTED_CHARACTERS' }) as Error,
      );
    }
    expect(
      buildSignedConsentPdfModel(source({ body: 'Uno\r\ndos' })).body,
    ).toBe('Uno\r\ndos');
  });

  it('una sede sin zona o sin formato no pinta con otro valor', () => {
    expect(() =>
      buildSignedConsentPdfModel(
        source({
          location: {
            name: 'X',
            timeZone: null,
            locale: 'es-VE',
            hourCycle: 'h12',
          },
        }),
      ),
    ).toThrow(SignedConsentPdfSourceError);
    expect(() =>
      buildSignedConsentPdfModel(
        source({
          location: {
            name: 'X',
            timeZone: 'America/Caracas',
            locale: null,
            hourCycle: 'h12',
          },
        }),
      ),
    ).toThrow(SignedConsentPdfSourceError);
  });
});

describe('signedConsentPdfFileName', () => {
  it('H1: el nombre del archivo es ASCII (Chromium descarta un filename* con UTF-8 y lo llama «download»)', () => {
    const name = signedConsentPdfFileName(
      'Consentimiento informado — Exodoncia «Clínica» ñ',
      new Date('2026-11-01T02:30:00.000Z'),
      'America/Caracas',
    );
    expect(name).toBe(
      "Consentimiento firmado - Consentimiento informado - Exodoncia 'Clinica' n - 2026-10-31.pdf",
    );
    expect(name).toMatch(/^[\x20-\x7e]+$/);
  });

  it('nombre con el título saneado y el día civil de la sede', () => {
    expect(
      signedConsentPdfFileName(
        'Consentimiento: Exodoncia / 38',
        new Date('2026-11-01T02:30:00.000Z'),
        'America/Caracas',
      ),
    ).toBe(
      'Consentimiento firmado - Consentimiento Exodoncia 38 - 2026-10-31.pdf',
    );
  });
});

describe('signedConsentPdfErrorCode', () => {
  it('códigos técnicos, nunca el mensaje', () => {
    expect(
      signedConsentPdfErrorCode(
        new SignedConsentPdfSourceError('INTEGRITY_MISMATCH'),
      ),
    ).toBe('INTEGRITY_MISMATCH');
    expect(signedConsentPdfErrorCode(new Error('laura@example.com'))).toBe(
      'GENERATION_ERROR',
    );
    expect(signedConsentPdfErrorCode('x')).toBe('GENERATION_ERROR');
  });
});
