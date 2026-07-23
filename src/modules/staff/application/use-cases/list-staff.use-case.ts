import { Inject, Injectable } from '@nestjs/common';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';

@Injectable()
export class ListStaffUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
  ) {}

  execute(): Promise<StaffMember[]> {
    return this.repo.listActive();
  }
}
