import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type {
  StaffPatch,
  StaffRepository,
} from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

export interface UpdateStaffInput {
  userId: string;
  fullName?: string;
  role?: ClinicRole;
  /** `''` o solo espacios lo borran. */
  professionalLicense?: string;
  /** `''` o solo espacios la borran. */
  professionalSpecialty?: string;
}

@Injectable()
export class UpdateStaffUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
  ) {}
  /** DX-359: `ctx` es quién cambia; el evento va en la transacción del cambio. */
  async execute(
    input: UpdateStaffInput,
    ctx: AuditRequestContext,
  ): Promise<StaffMember> {
    const patch: StaffPatch = {};
    if (input.role) patch.role = input.role;
    if (input.fullName) patch.fullName = input.fullName.trim();
    if (input.professionalLicense !== undefined) {
      patch.professionalLicense = input.professionalLicense.trim() || null;
    }
    if (input.professionalSpecialty !== undefined) {
      patch.professionalSpecialty = input.professionalSpecialty.trim() || null;
    }
    // "No dejar la clínica sin ADMIN" se comprueba y se escribe en la misma
    // transacción (ver StaffRepository.updateById, DB-012).
    const outcome = await this.repo.updateById(input.userId, patch, ctx);
    if (outcome.kind === 'NOT_FOUND')
      throw new NotFoundException('Staff member not found');
    if (outcome.kind === 'LAST_ADMIN')
      throw new ConflictException('Cannot demote the last admin');
    return outcome.member;
  }
}
