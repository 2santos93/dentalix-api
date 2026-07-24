import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';

export interface DeactivateStaffInput { userId: string; requestingUserId: string; }

@Injectable()
export class DeactivateStaffUseCase {
  constructor(@Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository) {}
  async execute(input: DeactivateStaffInput): Promise<void> {
    if (input.userId === input.requestingUserId) throw new ConflictException('You cannot deactivate yourself');
    const current = await this.repo.findById(input.userId);
    if (!current) throw new NotFoundException('Staff member not found');
    if (current.role === ClinicRole.OWNER && (await this.repo.countActiveOwners()) <= 1) {
      throw new ConflictException('Cannot deactivate the last owner');
    }
    const ok = await this.repo.deactivateById(input.userId);
    if (!ok) throw new NotFoundException('Staff member not found');
  }
}
