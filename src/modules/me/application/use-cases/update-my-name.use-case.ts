import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import { USER_PROFILE_REPOSITORY } from '../../domain/ports/user-profile-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { ownNameAuditEvent } from '../../domain/own-account-audit';

export interface UpdateMyNameInput {
  userId: string;
  fullName: string;
}

@Injectable()
export class UpdateMyNameUseCase {
  constructor(
    @Inject(USER_PROFILE_REPOSITORY)
    private readonly repo: UserProfileRepository,
  ) {}

  /** DX-359: `ctx` es la sesión de clínica; el evento va en la transacción. */
  async execute(
    input: UpdateMyNameInput,
    ctx: AuditRequestContext,
  ): Promise<void> {
    const fullName = input.fullName.trim();
    if (!fullName) {
      throw new BadRequestException('Name cannot be empty');
    }
    await this.repo.updateName(input.userId, fullName, ownNameAuditEvent(ctx));
  }
}
