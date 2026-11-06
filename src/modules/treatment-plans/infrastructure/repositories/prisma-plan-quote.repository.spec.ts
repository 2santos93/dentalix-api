import { remoteEvidenceOf } from './prisma-plan-quote.repository';

const REMOTE = {
  signatureRequestId: '7d1f0b3e-1c2a-4d5e-9f60-1a2b3c4d5e6f',
  remoteChannel: 'EMAIL' as const,
  remoteDestinationMasked: 'ma***@example.com',
  remoteSentAt: new Date('2026-10-31T04:44:00.000Z'),
  remoteOpenedAt: new Date('2026-10-31T04:45:00.000Z'),
  remoteVerifiedAt: new Date('2026-10-31T04:45:30.000Z'),
};

describe('remoteEvidenceOf (DX-415, DX-514)', () => {
  it('a distancia: las evidencias y quién firmó (paciente o representante)', () => {
    expect(
      remoteEvidenceOf({
        ...REMOTE,
        signatureRequest: { signerType: 'GUARDIAN' },
      }),
    ).toMatchObject({
      signatureRequestId: REMOTE.signatureRequestId,
      signerType: 'GUARDIAN',
    });
  });

  it('sin la solicitud sigue siendo a distancia (nunca «Registró la firma»), sin el papel del firmante', () => {
    const evidence = remoteEvidenceOf({ ...REMOTE, signatureRequest: null });
    expect(evidence).not.toBeNull();
    expect(evidence).toMatchObject({
      channel: 'EMAIL',
      destinationMasked: 'ma***@example.com',
      sentAt: REMOTE.remoteSentAt,
    });
    expect(evidence).not.toHaveProperty('signerType');
  });

  it('en la clínica (sin evidencias): null', () => {
    expect(
      remoteEvidenceOf({
        signatureRequestId: null,
        remoteChannel: null,
        remoteDestinationMasked: null,
        remoteSentAt: null,
        remoteOpenedAt: null,
        remoteVerifiedAt: null,
        signatureRequest: null,
      }),
    ).toBeNull();
  });
});
