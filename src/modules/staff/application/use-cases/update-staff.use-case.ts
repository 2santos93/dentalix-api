import { ConflictException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';

export interface UpdateStaffInput { userId: string; fullName?: string; role?: ClinicRole; }

@Injectable()
export class UpdateStaffUseCase {
  constructor(@Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository) {}
  async execute(input: UpdateStaffInput): Promise<StaffMember> {
    const current = await this.repo.findById(input.userId);
    if (!current) throw new NotFoundException('Staff member not found');
    if (input.role && current.role === ClinicRole.OWNER && input.role !== ClinicRole.OWNER) {
      if ((await this.repo.countActiveOwners()) <= 1) throw new ConflictException('Cannot demote the last owner');
    }
    const patch: { fullName?: string; role?: ClinicRole } = {};
    if (input.role) patch.role = input.role;
    if (input.fullName) patch.fullName = input.fullName.trim();
    const updated = await this.repo.updateById(input.userId, patch);
    if (!updated) throw new NotFoundException('Staff member not found');
    return updated;
  }
}
