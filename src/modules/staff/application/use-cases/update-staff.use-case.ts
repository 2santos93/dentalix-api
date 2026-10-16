import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';

export interface UpdateStaffInput {
  userId: string;
  fullName?: string;
  role?: ClinicRole;
}

@Injectable()
export class UpdateStaffUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
  ) {}
  async execute(input: UpdateStaffInput): Promise<StaffMember> {
    const patch: { fullName?: string; role?: ClinicRole } = {};
    if (input.role) patch.role = input.role;
    if (input.fullName) patch.fullName = input.fullName.trim();
    // "No dejar la clínica sin ADMIN" se comprueba y se escribe en la misma
    // transacción (ver StaffRepository.updateById, DB-012).
    const outcome = await this.repo.updateById(input.userId, patch);
    if (outcome.kind === 'NOT_FOUND')
      throw new NotFoundException('Staff member not found');
    if (outcome.kind === 'LAST_ADMIN')
      throw new ConflictException('Cannot demote the last admin');
    return outcome.member;
  }
}
