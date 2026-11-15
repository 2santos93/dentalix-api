import {
  PAID_ON_FUTURE_MESSAGE,
  PAID_ON_TOO_OLD_MESSAGE,
  PAYMENT_LINK_CONCEPT_LABELS,
  buildPaymentLinkUrl,
  firstNameOnly,
  generatePaymentLinkToken,
  hashPaymentLinkToken,
  isWellFormedPaymentLinkToken,
  paidOnError,
  paymentLinkExpiresAt,
  paymentLinkStatus,
  paymentLinkWhatsAppMessage,
} from './payment-link';

describe('enlace de pago (DX-569)', () => {
  describe('token', () => {
    it('32 bytes en base64url (43 caracteres) y su SHA-256 en hex', () => {
      const token = generatePaymentLinkToken();
      expect(isWellFormedPaymentLinkToken(token)).toBe(true);
      expect(hashPaymentLinkToken(token)).toMatch(/^[0-9a-f]{64}$/);
      expect(hashPaymentLinkToken(token)).toBe(hashPaymentLinkToken(token));
      expect(generatePaymentLinkToken()).not.toBe(token);
    });

    it('descarta lo que no puede ser un token sin consultar la BD', () => {
      for (const bad of ['', 'abc', `${'a'.repeat(42)}=`, 'a'.repeat(44)]) {
        expect(isWellFormedPaymentLinkToken(bad)).toBe(false);
      }
    });

    it('la URL va a /pago/<token> del host de la clínica', () => {
      expect(buildPaymentLinkUrl('https://demo.dentalix.app', 'tok')).toBe(
        'https://demo.dentalix.app/pago/tok',
      );
    });
  });

  it('caduca a los 7 días', () => {
    const now = new Date('2026-11-14T12:00:00.000Z');
    expect(paymentLinkExpiresAt(now).toISOString()).toBe(
      '2026-11-21T12:00:00.000Z',
    );
  });

  describe('estado derivado', () => {
    const now = new Date('2026-11-14T12:00:00.000Z');
    const live = {
      expiresAt: new Date('2026-11-15T00:00:00.000Z'),
      usedAt: null,
      revokedAt: null,
    };

    it('vivo, usado, anulado o caducado', () => {
      expect(paymentLinkStatus(live, now)).toBe('LIVE');
      expect(paymentLinkStatus({ ...live, usedAt: now }, now)).toBe('USED');
      expect(paymentLinkStatus({ ...live, revokedAt: now }, now)).toBe(
        'REVOKED',
      );
      expect(paymentLinkStatus({ ...live, expiresAt: now }, now)).toBe(
        'EXPIRED',
      );
    });

    it('usado gana a caducado: el paciente ve «Ya recibimos tu reporte»', () => {
      expect(
        paymentLinkStatus(
          { ...live, usedAt: now, expiresAt: new Date(0) },
          now,
        ),
      ).toBe('USED');
    });
  });

  describe('fecha del pago: desde el día del enlace menos 2 hasta hoy en la sede', () => {
    const window = { linkCreatedOn: '2026-11-10', today: '2026-11-14' };

    it('admite los extremos', () => {
      expect(paidOnError('2026-11-08', window)).toBeNull();
      expect(paidOnError('2026-11-14', window)).toBeNull();
    });

    it('rechaza mañana y antes de la ventana', () => {
      expect(paidOnError('2026-11-15', window)).toBe(PAID_ON_FUTURE_MESSAGE);
      expect(paidOnError('2026-11-07', window)).toBe(PAID_ON_TOO_OLD_MESSAGE);
    });

    it('cruza el cambio de mes', () => {
      expect(
        paidOnError('2026-10-30', {
          linkCreatedOn: '2026-11-01',
          today: '2026-11-01',
        }),
      ).toBeNull();
    });
  });

  it('el mensaje de WhatsApp lleva saludo, clínica y enlace: ningún importe ni tratamiento', () => {
    const text = paymentLinkWhatsAppMessage({
      firstName: 'Laura',
      clinicName: 'Sonrisas del Norte',
      url: 'https://demo.dentalix.app/pago/tok',
    });
    expect(text).toContain('Hola Laura');
    expect(text).toContain('Sonrisas del Norte');
    expect(text).toContain('https://demo.dentalix.app/pago/tok');
    expect(text).not.toMatch(/\d+[.,]\d{2}|USD|VES|Bs|\$/);
    expect(
      paymentLinkWhatsAppMessage({
        firstName: null,
        clinicName: 'X',
        url: 'u',
      }),
    ).toMatch(/^Hola, /);
  });

  it('solo el nombre de pila', () => {
    expect(firstNameOnly('  Ana María ')).toBe('Ana');
    expect(firstNameOnly('')).toBeNull();
    expect(firstNameOnly(null)).toBeNull();
  });

  it('el concepto es genérico, sin tratamientos', () => {
    expect(PAYMENT_LINK_CONCEPT_LABELS).toEqual({
      INSTALLMENT: 'Cuota del plan de pagos',
      BALANCE: 'Saldo pendiente',
    });
  });
});
