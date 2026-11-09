import {
  EXPIRED_NOTE_REQUIRED_MESSAGE,
  EXPIRED_NOTE_TOO_LONG_MESSAGE,
  EXPIRED_ORIGINAL_NO_PREVIEW_MESSAGE,
  EXPIRED_PREVIEW_REQUIRED_MESSAGE,
  EXPIRED_REASON_LABELS,
  EXPIRED_REASON_REQUIRED_MESSAGE,
  EXPIRED_REPRICE_NO_REASON_MESSAGE,
  ExpiredAcceptanceInputError,
  expiredAcceptanceAuditReason,
  parseExpiredAcceptance,
  quoteExpiredAcceptMessage,
  type ExpiredAcceptanceInput,
} from './expired-quote-acceptance';

const HASH = 'a'.repeat(64);

function errorOf(input: ExpiredAcceptanceInput): string {
  try {
    parseExpiredAcceptance(input);
  } catch (error) {
    expect(error).toBeInstanceOf(ExpiredAcceptanceInputError);
    return (error as Error).message;
  }
  throw new Error('no lanzó');
}

describe('parseExpiredAcceptance (DX-379 C)', () => {
  it('precios originales con motivo; la nota se recorta y es opcional salvo con OTHER', () => {
    expect(
      parseExpiredAcceptance({ mode: 'ORIGINAL_PRICES', reason: 'LOYALTY' }),
    ).toEqual({ mode: 'ORIGINAL_PRICES', reason: 'LOYALTY', note: null });
    expect(
      parseExpiredAcceptance({
        mode: 'ORIGINAL_PRICES',
        reason: 'OTHER',
        note: '  Promesa de la directora  ',
      }),
    ).toEqual({
      mode: 'ORIGINAL_PRICES',
      reason: 'OTHER',
      note: 'Promesa de la directora',
    });
    expect(
      parseExpiredAcceptance({
        mode: 'ORIGINAL_PRICES',
        reason: 'CLINIC_DELAY',
        note: '   ',
      }),
    ).toEqual({ mode: 'ORIGINAL_PRICES', reason: 'CLINIC_DELAY', note: null });
  });

  it('precios originales: sin motivo, OTHER sin nota, nota larga o con huella → 400', () => {
    expect(errorOf({ mode: 'ORIGINAL_PRICES' })).toBe(
      EXPIRED_REASON_REQUIRED_MESSAGE,
    );
    expect(errorOf({ mode: 'ORIGINAL_PRICES', reason: 'OTHER' })).toBe(
      EXPIRED_NOTE_REQUIRED_MESSAGE,
    );
    expect(
      errorOf({ mode: 'ORIGINAL_PRICES', reason: 'OTHER', note: ' ' }),
    ).toBe(EXPIRED_NOTE_REQUIRED_MESSAGE);
    expect(
      errorOf({
        mode: 'ORIGINAL_PRICES',
        reason: 'LOYALTY',
        note: 'x'.repeat(201),
      }),
    ).toBe(EXPIRED_NOTE_TOO_LONG_MESSAGE);
    expect(
      errorOf({
        mode: 'ORIGINAL_PRICES',
        reason: 'LOYALTY',
        repricePreviewHash: HASH,
      }),
    ).toBe(EXPIRED_ORIGINAL_NO_PREVIEW_MESSAGE);
  });

  it('actualizar precios exige la huella de la vista previa y no lleva motivo', () => {
    expect(
      parseExpiredAcceptance({
        mode: 'REPRICE',
        repricePreviewHash: HASH.toUpperCase(),
      }),
    ).toEqual({ mode: 'REPRICE', repricePreviewHash: HASH });
    expect(errorOf({ mode: 'REPRICE' })).toBe(EXPIRED_PREVIEW_REQUIRED_MESSAGE);
    expect(
      errorOf({ mode: 'REPRICE', reason: 'LOYALTY', repricePreviewHash: HASH }),
    ).toBe(EXPIRED_REPRICE_NO_REASON_MESSAGE);
    expect(
      errorOf({ mode: 'REPRICE', note: 'nota', repricePreviewHash: HASH }),
    ).toBe(EXPIRED_REPRICE_NO_REASON_MESSAGE);
  });

  it('textos y códigos de auditoría', () => {
    expect(quoteExpiredAcceptMessage('03/11/2026')).toBe(
      'El presupuesto venció el 03/11/2026. Actualiza los precios o acepta con los precios originales indicando el motivo.',
    );
    expect(EXPIRED_REASON_LABELS.CLINIC_DELAY).toBe(
      'La clínica tardó en cerrarlo',
    );
    expect(expiredAcceptanceAuditReason('REPRICE')).toBe(
      'QUOTE_EXPIRED_REPRICED',
    );
    expect(expiredAcceptanceAuditReason('ORIGINAL_PRICES')).toBe(
      'QUOTE_EXPIRED_ORIGINAL_PRICES',
    );
  });
});
