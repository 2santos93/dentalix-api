import {
  isLinkUsable,
  signatureRequestStatus,
  type SignatureStatusInput,
} from './signature-request-status';

const now = new Date('2026-10-30T12:00:00.000Z');
const base: SignatureStatusInput = {
  expiresAt: new Date('2026-11-02T12:00:00.000Z'),
  openedAt: null,
  lockedAt: null,
  revokedAt: null,
  signedAt: null,
  countersigned: false,
};

describe('estado de una solicitud de firma a distancia (DX-243)', () => {
  it('Enviado → Abierto', () => {
    expect(signatureRequestStatus(base, now)).toBe('SENT');
    expect(signatureRequestStatus({ ...base, openedAt: now }, now)).toBe(
      'OPENED',
    );
  });

  it('Bloqueado tras 5 fallos, aunque siga en plazo', () => {
    expect(
      signatureRequestStatus({ ...base, openedAt: now, lockedAt: now }, now),
    ).toBe('LOCKED');
  });

  it('Caducado cuando llega expiresAt (incluido el instante exacto)', () => {
    expect(signatureRequestStatus({ ...base, expiresAt: now }, now)).toBe(
      'EXPIRED',
    );
  });

  it('Anulado pesa más que bloqueado o caducado', () => {
    expect(
      signatureRequestStatus(
        { ...base, lockedAt: now, revokedAt: now, expiresAt: now },
        now,
      ),
    ).toBe('REVOKED');
  });

  it('Firmado por paciente y, con la firma del profesional, Completo (aunque caduque el enlace)', () => {
    const signed = { ...base, openedAt: now, signedAt: now, expiresAt: now };
    expect(signatureRequestStatus(signed, now)).toBe('SIGNED_BY_PATIENT');
    expect(
      signatureRequestStatus({ ...signed, countersigned: true }, now),
    ).toBe('COMPLETE');
  });

  it('el enlace solo sirve si no está caducado, usado, anulado ni bloqueado', () => {
    expect(isLinkUsable(base, now)).toBe(true);
    expect(isLinkUsable({ ...base, openedAt: now }, now)).toBe(true);
    expect(isLinkUsable({ ...base, expiresAt: now }, now)).toBe(false);
    expect(isLinkUsable({ ...base, signedAt: now }, now)).toBe(false);
    expect(isLinkUsable({ ...base, revokedAt: now }, now)).toBe(false);
    expect(isLinkUsable({ ...base, lockedAt: now }, now)).toBe(false);
  });
});
