import {
  confirmationState,
  firstNameOnly,
  generateConfirmationToken,
  hashConfirmationToken,
  isWellFormedConfirmationToken,
} from './confirmation-token';

const NOW = new Date('2026-10-20T12:00:00.000Z');
const START = new Date('2026-10-21T14:00:00.000Z');

function pending() {
  return {
    expiresAt: START,
    appointmentStart: START,
    appointmentStatus: 'SCHEDULED' as const,
    respondedAt: null,
    revokedAt: null,
  };
}

function appointment() {
  return { start: START, status: 'SCHEDULED' as const };
}

describe('confirmation-token', () => {
  it('genera tokens de 32 bytes aleatorios en base64url (43 caracteres)', () => {
    const a = generateConfirmationToken();
    const b = generateConfirmationToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(a, 'base64url')).toHaveLength(32);
    expect(a).not.toBe(b);
    expect(isWellFormedConfirmationToken(a)).toBe(true);
  });

  it('rechaza tokens mal formados sin tocar la BD', () => {
    expect(isWellFormedConfirmationToken('')).toBe(false);
    expect(isWellFormedConfirmationToken('guess-1')).toBe(false);
    expect(isWellFormedConfirmationToken('a'.repeat(44))).toBe(false);
    expect(isWellFormedConfirmationToken(`${'a'.repeat(42)}+`)).toBe(false);
  });

  it('el hash es sha256 hex estable y distinto del token', () => {
    const token = generateConfirmationToken();
    const hash = hashConfirmationToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashConfirmationToken(token)).toBe(hash);
    expect(hash).not.toContain(token);
  });

  describe('confirmationState', () => {
    it('PENDING mientras no se respondió, no expiró y la cita sigue igual', () => {
      expect(confirmationState(pending(), appointment(), NOW)).toBe('PENDING');
    });

    it('RESPONDED gana a todo lo demás (muestra la respuesta ya dada)', () => {
      const conf = { ...pending(), respondedAt: NOW };
      const after = new Date(START.getTime() + 1);
      expect(
        confirmationState(conf, { start: START, status: 'CONFIRMED' }, after),
      ).toBe('RESPONDED');
      expect(confirmationState(conf, null, after)).toBe('RESPONDED');
    });

    it('EXPIRED al llegar el inicio de la cita', () => {
      expect(confirmationState(pending(), appointment(), START)).toBe(
        'EXPIRED',
      );
    });

    it('EXPIRED si se revocó (se emitió otro enlace)', () => {
      expect(
        confirmationState({ ...pending(), revokedAt: NOW }, appointment(), NOW),
      ).toBe('EXPIRED');
    });

    it('EXPIRED si la cita se reagendó, cambió de estado o ya no existe', () => {
      const moved = {
        start: new Date(START.getTime() + 60_000),
        status: 'SCHEDULED' as const,
      };
      expect(confirmationState(pending(), moved, NOW)).toBe('EXPIRED');
      expect(
        confirmationState(
          pending(),
          { start: START, status: 'CANCELLED' },
          NOW,
        ),
      ).toBe('EXPIRED');
      expect(confirmationState(pending(), null, NOW)).toBe('EXPIRED');
    });
  });

  it('firstNameOnly deja solo el nombre de pila', () => {
    expect(firstNameOnly('  Ana María ')).toBe('Ana');
    expect(firstNameOnly('Luis')).toBe('Luis');
    expect(firstNameOnly(null)).toBeNull();
    expect(firstNameOnly('   ')).toBeNull();
  });
});
