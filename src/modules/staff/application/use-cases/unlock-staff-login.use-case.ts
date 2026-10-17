import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { STAFF_LOGIN_LOCKS } from '../../domain/ports/staff-login-locks.port';
import type { StaffLoginLocks } from '../../domain/ports/staff-login-locks.port';
import { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

/** DX-213: la cuenta da acceso a otra clínica (sin decir cuál ni cuántas). */
export const LOGIN_UNLOCK_OTHER_CLINIC_MESSAGE =
  'Esta cuenta da acceso a otra clínica: pide a la persona que espere unos minutos o que restablezca su contraseña';

/**
 * Un ADMIN desbloquea el inicio de sesión de un miembro de SU clínica
 * (DX-048): borra la espera y los fallos acumulados de su cuenta. El miembro
 * se busca bajo RLS: un usuario de otra clínica no existe aquí y da 404, sin
 * tocar ningún contador. Idempotente: desbloquear a quien no está bloqueado
 * no falla.
 *
 * DX-213 (SEC-038): el contador es por CUENTA, no por clínica, así que
 * borrarlo solo es asunto de esta clínica si la cuenta no da acceso a otra.
 * Sin tocar el contador:
 * - membresía desactivada → el mismo 404 que un no miembro;
 * - membresía activa en otra clínica → 409.
 * Los dos rechazos quedan auditados (`LOGIN_UNLOCK_REFUSED`, solo el userId:
 * nunca el email). El desbloqueo hecho lo audita el `@Audit` del endpoint.
 */
@Injectable()
export class UnlockStaffLoginUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
    @Inject(STAFF_LOGIN_LOCKS) private readonly locks: StaffLoginLocks,
    private readonly audit: RecordAuditEventUseCase,
  ) {}

  async execute(userId: string, ctx: AuditRequestContext): Promise<void> {
    const member = await this.repo.findDetailById(userId);
    if (!member) throw new NotFoundException('Staff member not found');
    if (member.status === 'INACTIVE') {
      await this.recordRefusal(userId, ctx);
      throw new NotFoundException('Staff member not found');
    }
    if (await this.repo.hasOtherActiveMemberships(userId)) {
      await this.recordRefusal(userId, ctx);
      throw new ConflictException(LOGIN_UNLOCK_OTHER_CLINIC_MESSAGE);
    }
    await this.locks.unlock(member.email);
  }

  private recordRefusal(
    userId: string,
    ctx: AuditRequestContext,
  ): Promise<void> {
    return this.audit.record({
      tenantId: ctx.tenantId,
      locationId: ctx.locationId,
      actor: { kind: 'user', userId: ctx.actor.userId, role: ctx.actor.role },
      action: 'UPDATE',
      resourceType: 'STAFF_MEMBER',
      resourceId: userId,
      patient: null,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      metadata: { reason: 'LOGIN_UNLOCK_REFUSED' },
    });
  }
}
