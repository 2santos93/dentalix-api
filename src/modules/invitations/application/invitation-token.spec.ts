import {
  generateInvitationToken,
  hashInvitationToken,
  maskEmail,
  invitationStatus,
} from './invitation-token';

it('genera tokens distintos y suficientemente largos', () => {
  const a = generateInvitationToken();
  const b = generateInvitationToken();
  expect(a).not.toBe(b);
  expect(a).toMatch(/^[0-9a-f]{64}$/);
});

it('hashea de forma estable y distinta del token', () => {
  const t = generateInvitationToken();
  expect(hashInvitationToken(t)).toBe(hashInvitationToken(t));
  expect(hashInvitationToken(t)).not.toBe(t);
  expect(hashInvitationToken(t)).toMatch(/^[0-9a-f]{64}$/);
});

it('enmascara el correo dejando dos letras', () => {
  expect(maskEmail('maria@correo.com')).toBe('ma***@correo.com');
  expect(maskEmail('al@correo.com')).toBe('al***@correo.com');
  expect(maskEmail('a@correo.com')).toBe('a***@correo.com');
});

it('clasifica el estado por precedencia: revocada > usada > expirada', () => {
  const now = new Date('2026-08-01T12:00:00Z');
  const future = new Date('2026-08-05T12:00:00Z');
  const past = new Date('2026-07-30T12:00:00Z');
  expect(
    invitationStatus(
      { expiresAt: future, acceptedAt: null, revokedAt: null },
      now,
    ),
  ).toBe('VALID');
  expect(
    invitationStatus(
      { expiresAt: past, acceptedAt: null, revokedAt: null },
      now,
    ),
  ).toBe('EXPIRED');
  expect(
    invitationStatus(
      { expiresAt: future, acceptedAt: now, revokedAt: null },
      now,
    ),
  ).toBe('USED');
  expect(
    invitationStatus({ expiresAt: past, acceptedAt: now, revokedAt: now }, now),
  ).toBe('REVOKED');
});
