import { FakeInvitationNotifier } from './__fixtures__/fake-invitation-notifier';
import { NotFoundException } from '@nestjs/common';
import { RevokeInvitationUseCase } from './revoke-invitation.use-case';
import { InMemoryInvitationRepository } from './__fixtures__/in-memory-invitation.repository';

describe('RevokeInvitationUseCase', () => {
  it('revoca una invitación pendiente existente', async () => {
    const repo = new InMemoryInvitationRepository();
    const invitation = repo.seedInvitation();
    const uc = new RevokeInvitationUseCase(repo, new FakeInvitationNotifier());

    await uc.execute(invitation.id);

    const pending = await repo.listPending();
    expect(pending).toHaveLength(0);
  });

  it('cancela el email pendiente de la invitación revocada (DX-088)', async () => {
    const repo = new InMemoryInvitationRepository();
    const invitation = repo.seedInvitation();
    const notifier = new FakeInvitationNotifier();
    await new RevokeInvitationUseCase(repo, notifier).execute(invitation.id);
    expect(notifier.cancelled).toEqual([invitation.id]);
  });

  it('404 si el id no existe (o ya no está pendiente)', async () => {
    const uc = new RevokeInvitationUseCase(
      new InMemoryInvitationRepository(),
      new FakeInvitationNotifier(),
    );

    await expect(uc.execute('does-not-exist')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
