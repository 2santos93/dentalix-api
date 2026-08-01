import { NotFoundException } from '@nestjs/common';
import { RevokeInvitationUseCase } from './revoke-invitation.use-case';
import { InMemoryInvitationRepository } from './__fixtures__/in-memory-invitation.repository';

describe('RevokeInvitationUseCase', () => {
  it('revoca una invitación pendiente existente', async () => {
    const repo = new InMemoryInvitationRepository();
    const invitation = repo.seedInvitation();
    const uc = new RevokeInvitationUseCase(repo);

    await uc.execute(invitation.id);

    const pending = await repo.listPending();
    expect(pending).toHaveLength(0);
  });

  it('404 si el id no existe (o ya no está pendiente)', async () => {
    const uc = new RevokeInvitationUseCase(new InMemoryInvitationRepository());

    await expect(uc.execute('does-not-exist')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
