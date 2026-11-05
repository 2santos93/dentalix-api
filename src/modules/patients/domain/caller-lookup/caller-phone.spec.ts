import {
  MIN_CALLER_DIGITS,
  callerPhoneCandidates,
  storedPhoneE164,
} from './caller-phone';

// Dos sedes: Caracas (VE, +58) y Madrid (ES, +34).
const VE = 'VE';
const ES = 'ES';

describe('storedPhoneE164 (DX-224, A1)', () => {
  it('lee el número con el prefijo por defecto de la sede', () => {
    expect(storedPhoneE164('0412-123.45.67', VE)).toBe('+584121234567');
    expect(storedPhoneE164('(0412) 1234567', VE)).toBe('+584121234567');
    expect(storedPhoneE164('412 1234567', VE)).toBe('+584121234567');
    expect(storedPhoneE164('0212 555 66 77', VE)).toBe('+582125556677');
  });

  it('con «+» el número trae su indicativo y la sede no cuenta', () => {
    expect(storedPhoneE164('+58 412 1234567', VE)).toBe('+584121234567');
    expect(storedPhoneE164('+58 412 1234567', ES)).toBe('+584121234567');
    expect(storedPhoneE164('+34 612 345 678', VE)).toBe('+34612345678');
  });

  it('la misma escritura vale distinto según la sede (sin ramas por país)', () => {
    expect(storedPhoneE164('612 345 678', ES)).toBe('+34612345678');
    expect(storedPhoneE164('612 345 678', VE)).toBeNull();
  });

  it('sin sede con prefijo, un número sin «+» no se adivina', () => {
    expect(storedPhoneE164('0412 1234567', null)).toBeNull();
    expect(storedPhoneE164('+58 412 1234567', null)).toBe('+584121234567');
  });

  it('vacío, texto o inválido: null', () => {
    expect(storedPhoneE164(null, VE)).toBeNull();
    expect(storedPhoneE164('   ', VE)).toBeNull();
    expect(storedPhoneE164('llamar a mamá', VE)).toBeNull();
    expect(storedPhoneE164('12345', VE)).toBeNull();
  });

  it('ignora la extensión', () => {
    expect(storedPhoneE164('0212 555 66 77 ext. 12', VE)).toBe('+582125556677');
  });
});

describe('callerPhoneCandidates (DX-224, A2)', () => {
  it('menos de 7 dígitos: TOO_SHORT', () => {
    expect(MIN_CALLER_DIGITS).toBe(7);
    expect(callerPhoneCandidates('412 123', VE)).toEqual({
      status: 'TOO_SHORT',
    });
    expect(callerPhoneCandidates('', VE)).toEqual({ status: 'TOO_SHORT' });
    expect(callerPhoneCandidates('+58 412', VE)).toEqual({
      status: 'TOO_SHORT',
    });
  });

  it.each([
    '0412-123.45.67',
    '412 1234567',
    '+58 412 1234567',
    '(0412) 1234567',
    '0058412 1234567',
  ])('«%s» da el mismo E.164 completo', (text) => {
    expect(callerPhoneCandidates(text, VE)).toEqual({
      status: 'OK',
      e164s: ['+584121234567'],
    });
  });

  it('en la sede de Madrid usa +34 sin prefijo y respeta el «+»', () => {
    expect(callerPhoneCandidates('612 345 678', ES)).toEqual({
      status: 'OK',
      e164s: ['+34612345678'],
    });
    expect(callerPhoneCandidates('+58 414 1234567', ES)).toEqual({
      status: 'OK',
      e164s: ['+584141234567'],
    });
  });

  it('7 o más dígitos que no forman un número: sin candidatos', () => {
    expect(callerPhoneCandidates('1234567', VE)).toEqual({ status: 'NONE' });
    expect(callerPhoneCandidates('0412 1234567', null)).toEqual({
      status: 'NONE',
    });
  });
});
