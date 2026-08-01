import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';

@Injectable()
export class GetStaffDetailUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
  ) {}

  async execute(
    userId: string,
  ): Promise<StaffMember & { status: 'ACTIVE' | 'INACTIVE' }> {
    // `findDetailById` (no `findById`): el perfil de un desactivado tiene que
    // poder abrirse, porque es desde donde se le reactiva.
    const member = await this.repo.findDetailById(userId);
    if (!member) throw new NotFoundException('Staff member not found');
    return member;
  }
}
