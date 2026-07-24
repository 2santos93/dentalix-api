import { BadRequestException, ConflictException, Inject, Injectable } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import { PasswordService } from '../../../../shared/crypto/password.service';

export interface CreateStaffInput { fullName: string; email: string; role: ClinicRole; password: string; }

@Injectable()
export class CreateStaffUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
    private readonly password: PasswordService,
  ) {}

  async execute(input: CreateStaffInput): Promise<StaffMember> {
    const email = input.email.trim().toLowerCase();
    const fullName = input.fullName.trim();
    if (fullName.length < 2) throw new BadRequestException('fullName must be at least 2 characters');
    if (!input.password || input.password.length < 8) throw new BadRequestException('password must be at least 8 characters');
    if (!Object.values(ClinicRole).includes(input.role)) throw new BadRequestException('invalid role');
    if (await this.repo.findUserByEmailGlobal(email)) throw new ConflictException('Email already registered');
    const passwordHash = await this.password.hash(input.password);
    return this.repo.create({ fullName, email, role: input.role, passwordHash });
  }
}
