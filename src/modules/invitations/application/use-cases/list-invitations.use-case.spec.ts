import { ListInvitationsUseCase } from './list-invitations.use-case';
import { InMemoryInvitationRepository } from './__fixtures__/in-memory-invitation.repository';

describe('ListInvitationsUseCase', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('adjunta el status calculado a cada invitación pendiente', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-08-01T00:00:00.000Z'));
    const repo = new InMemoryInvitationRepository();
    const valid = repo.seedInvitation({
      email: 'valid@clinic.com',
      expiresAt: new Date('2026-08-10T00:00:00.000Z'),
    });
    const expired = repo.seedInvitation({
      email: 'expired@clinic.com',
      expiresAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const uc = new ListInvitationsUseCase(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(2);
    expect(result.find((i) => i.id === valid.id)?.status).toBe('VALID');
    expect(result.find((i) => i.id === expired.id)?.status).toBe('EXPIRED');
  });

  it('no incluye invitaciones aceptadas ni revocadas (las filtra listPending)', async () => {
    const repo = new InMemoryInvitationRepository();
    repo.seedInvitation({ acceptedAt: new Date('2026-07-01T00:00:00.000Z') });
    repo.seedInvitation({ revokedAt: new Date('2026-07-01T00:00:00.000Z') });
    const uc = new ListInvitationsUseCase(repo);

    const result = await uc.execute();

    expect(result).toHaveLength(0);
  });
});
