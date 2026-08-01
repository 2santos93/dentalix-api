import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';

@Injectable()
export class ReactivateStaffUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
  ) {}

  async execute(userId: string): Promise<StaffMember> {
    // Sin guardia de "último admin" aquí: reactivar SUMA acceso, nunca lo
    // quita, así que no puede dejar la clínica sin administradores (que es lo
    // que protege `deactivate`).
    const member = await this.repo.reactivateById(userId);
    if (!member) {
      throw new NotFoundException('No inactive staff member to reactivate');
    }
    return member;
  }
}
