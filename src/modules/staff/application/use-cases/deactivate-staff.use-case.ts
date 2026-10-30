import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

export interface DeactivateStaffInput {
  userId: string;
  requestingUserId: string;
}

@Injectable()
export class DeactivateStaffUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
  ) {}
  /** DX-359: `ctx` es quién desactiva; el evento va en la transacción. */
  async execute(
    input: DeactivateStaffInput,
    ctx: AuditRequestContext,
  ): Promise<void> {
    if (input.userId === input.requestingUserId)
      throw new ConflictException('You cannot deactivate yourself');
    // "No dejar la clínica sin ADMIN" se comprueba y se escribe en la misma
    // transacción (ver StaffRepository.deactivateById, DB-012).
    const outcome = await this.repo.deactivateById(input.userId, ctx);
    if (outcome === 'NOT_FOUND')
      throw new NotFoundException('Staff member not found');
    if (outcome === 'LAST_ADMIN')
      throw new ConflictException('Cannot deactivate the last admin');
  }
}
