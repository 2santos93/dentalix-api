import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { STAFF_LOGIN_LOCKS } from '../../domain/ports/staff-login-locks.port';
import type { StaffLoginLocks } from '../../domain/ports/staff-login-locks.port';

/**
 * Un ADMIN desbloquea el inicio de sesión de un miembro de SU clínica
 * (DX-048): borra la espera y los fallos acumulados de su cuenta. El miembro
 * se busca bajo RLS (`findDetailById`, también los desactivados): un usuario
 * de otra clínica no existe aquí y da 404, sin tocar ningún contador.
 * Idempotente: desbloquear a quien no está bloqueado no falla.
 */
@Injectable()
export class UnlockStaffLoginUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
    @Inject(STAFF_LOGIN_LOCKS) private readonly locks: StaffLoginLocks,
  ) {}

  async execute(userId: string): Promise<void> {
    const member = await this.repo.findDetailById(userId);
    if (!member) throw new NotFoundException('Staff member not found');
    await this.locks.unlock(member.email);
  }
}
