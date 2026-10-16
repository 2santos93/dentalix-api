import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordPolicyViolation,
} from './password-policy';

describe('passwordPolicyViolation', () => {
  it('acepta una contraseña de la longitud mínima y de la máxima', () => {
    expect(passwordPolicyViolation('a'.repeat(PASSWORD_MIN_LENGTH))).toBeNull();
    expect(passwordPolicyViolation('a'.repeat(PASSWORD_MAX_LENGTH))).toBeNull();
  });

  it('rechaza una contraseña corta con el motivo en español', () => {
    expect(passwordPolicyViolation('corta')).toBe(
      'La contraseña debe tener al menos 8 caracteres.',
    );
  });

  it('rechaza una contraseña demasiado larga', () => {
    expect(passwordPolicyViolation('a'.repeat(PASSWORD_MAX_LENGTH + 1))).toBe(
      'La contraseña no puede tener más de 200 caracteres.',
    );
  });

  it('rechaza lo que no es texto', () => {
    expect(passwordPolicyViolation(undefined)).toBe(
      'La contraseña es obligatoria.',
    );
    expect(passwordPolicyViolation(12345678)).toBe(
      'La contraseña es obligatoria.',
    );
  });
});
