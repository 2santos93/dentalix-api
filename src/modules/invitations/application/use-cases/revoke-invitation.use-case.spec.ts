import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { ClinicRole } from '@prisma/client';
import { FakeInvitationNotifier } from './__fixtures__/fake-invitation-notifier';
import { NotFoundException } from '@nestjs/common';
import { RevokeInvitationUseCase } from './revoke-invitation.use-case';
import { InMemoryInvitationRepository } from './__fixtures__/in-memory-invitation.repository';

// DX-359: quién gestiona la invitación (el evento va en la transacción).
const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'admin-1', role: ClinicRole.ADMIN },
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

describe('RevokeInvitationUseCase', () => {
  it('DX-359: retirar deja su evento (PENDING → REVOKED); si no había nada que retirar, ninguno', async () => {
    const repo = new InMemoryInvitationRepository();
    const invitation = repo.seedInvitation();
    const uc = new RevokeInvitationUseCase(repo, new FakeInvitationNotifier());
    await uc.execute(invitation.id, CTX);
    await expect(uc.execute(invitation.id, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(repo.auditEvents).toEqual([
      expect.objectContaining({
        action: 'VOID',
        resourceType: 'STAFF_INVITATION',
        resourceId: invitation.id,
        metadata: {
          reason: 'INVITATION_REVOKED',
          statusChange: { from: 'PENDING', to: 'REVOKED' },
        },
      }),
    ]);
  });

  it('revoca una invitación pendiente existente', async () => {
    const repo = new InMemoryInvitationRepository();
    const invitation = repo.seedInvitation();
    const uc = new RevokeInvitationUseCase(repo, new FakeInvitationNotifier());

    await uc.execute(invitation.id, CTX);

    const pending = await repo.listPending();
    expect(pending).toHaveLength(0);
  });

  it('cancela el email pendiente de la invitación revocada (DX-088)', async () => {
    const repo = new InMemoryInvitationRepository();
    const invitation = repo.seedInvitation();
    const notifier = new FakeInvitationNotifier();
    await new RevokeInvitationUseCase(repo, notifier).execute(
      invitation.id,
      CTX,
    );
    expect(notifier.cancelled).toEqual([invitation.id]);
  });

  it('404 si el id no existe (o ya no está pendiente)', async () => {
    const uc = new RevokeInvitationUseCase(
      new InMemoryInvitationRepository(),
      new FakeInvitationNotifier(),
    );

    await expect(uc.execute('does-not-exist', CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
