import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { STAFF_LOGIN_LOCKS } from '../../domain/ports/staff-login-locks.port';
import type { StaffLoginLocks } from '../../domain/ports/staff-login-locks.port';
import { StaffMember } from '../../domain/entities/staff-member.entity';

export type StaffMemberDetail = StaffMember & {
  status: 'ACTIVE' | 'INACTIVE';
  /** DX-048: hasta cuándo no puede iniciar sesión; `null` = sin bloqueo. */
  loginBlockedUntil: Date | null;
};

@Injectable()
export class GetStaffDetailUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
    @Inject(STAFF_LOGIN_LOCKS) private readonly locks: StaffLoginLocks,
  ) {}

  async execute(userId: string): Promise<StaffMemberDetail> {
    // `findDetailById` (no `findById`): el perfil de un desactivado tiene que
    // poder abrirse, porque es desde donde se le reactiva.
    const member = await this.repo.findDetailById(userId);
    if (!member) throw new NotFoundException('Staff member not found');
    // DX-213 (SEC-038): el contador es de la cuenta, no de la clínica. De un
    // desactivado no se dice nada (sus fallos pueden ser en otra clínica).
    const loginBlockedUntil =
      member.status === 'ACTIVE'
        ? await this.locks.blockedUntil(member.email)
        : null;
    return { ...member, loginBlockedUntil };
  }
}
