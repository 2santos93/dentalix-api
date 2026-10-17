import { ClinicRole } from '@prisma/client';
import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  LOGIN_UNLOCK_OTHER_CLINIC_MESSAGE,
  UnlockStaffLoginUseCase,
} from './unlock-staff-login.use-case';
import { GetStaffDetailUseCase } from './get-staff-detail.use-case';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import type { StaffLoginLocks } from '../../domain/ports/staff-login-locks.port';
import type { StaffMember } from '../../domain/entities/staff-member.entity';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';

type Detail = StaffMember & { status: 'ACTIVE' | 'INACTIVE' };

const doctora: Detail = {
  userId: 'u1',
  fullName: 'Ana Ríos',
  email: 'ana@clinic.com',
  role: ClinicRole.DENTIST,
  status: 'ACTIVE',
};
const desactivada: Detail = { ...doctora, status: 'INACTIVE' };

const ctx: AuditRequestContext = {
  tenantId: 't-a',
  locationId: 'loc-1',
  actor: { userId: 'admin-1', role: ClinicRole.ADMIN },
  requestId: 'req-1',
  ip: '198.51.100.10',
  userAgent: 'jest',
};

function setup(
  member: Detail | null,
  blockedUntil: Date | null,
  otherClinic = false,
) {
  const findDetailById = jest.fn().mockResolvedValue(member);
  const hasOtherActiveMemberships = jest.fn().mockResolvedValue(otherClinic);
  const repo = {
    findDetailById,
    hasOtherActiveMemberships,
  } as unknown as StaffRepository;
  const unlock = jest.fn().mockResolvedValue(undefined);
  const blocked = jest.fn().mockResolvedValue(blockedUntil);
  const locks: StaffLoginLocks = { blockedUntil: blocked, unlock };
  const drafts: AuditEventDraft[] = [];
  const audit = {
    record: jest.fn((d: AuditEventDraft) => {
      drafts.push(d);
      return Promise.resolve();
    }),
  } as unknown as RecordAuditEventUseCase;
  return {
    repo,
    locks,
    audit,
    drafts,
    findDetailById,
    hasOtherActiveMemberships,
    unlock,
    blocked,
  };
}

describe('UnlockStaffLoginUseCase (DX-048, DX-213)', () => {
  it('desbloquea por el email del miembro activo que solo pertenece a ESTA clínica', async () => {
    const s = setup(doctora, new Date());
    await new UnlockStaffLoginUseCase(s.repo, s.locks, s.audit).execute(
      'u1',
      ctx,
    );
    expect(s.findDetailById).toHaveBeenCalledWith('u1');
    expect(s.hasOtherActiveMemberships).toHaveBeenCalledWith('u1');
    expect(s.unlock).toHaveBeenCalledWith('ana@clinic.com');
    // El éxito lo audita el @Audit del controlador, no el caso de uso.
    expect(s.drafts).toEqual([]);
  });

  it('404 si no es miembro de la clínica (otra clínica o inexistente), sin tocar contadores ni auditar', async () => {
    const s = setup(null, null);
    await expect(
      new UnlockStaffLoginUseCase(s.repo, s.locks, s.audit).execute(
        'u-otra',
        ctx,
      ),
    ).rejects.toThrow(NotFoundException);
    expect(s.unlock).not.toHaveBeenCalled();
    expect(s.drafts).toEqual([]);
  });

  it('404 si la membresía está desactivada: no toca el contador y audita el rechazo', async () => {
    const s = setup(desactivada, new Date());
    const err = await new UnlockStaffLoginUseCase(s.repo, s.locks, s.audit)
      .execute('u1', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    // Mismo 404 que un usuario que no es de la clínica.
    expect((err as NotFoundException).message).toBe('Staff member not found');
    expect(s.unlock).not.toHaveBeenCalled();
    expect(s.hasOtherActiveMemberships).not.toHaveBeenCalled();
    expect(s.drafts).toEqual([
      {
        tenantId: 't-a',
        locationId: 'loc-1',
        actor: { kind: 'user', userId: 'admin-1', role: ClinicRole.ADMIN },
        action: 'UPDATE',
        resourceType: 'STAFF_MEMBER',
        resourceId: 'u1',
        patient: null,
        requestId: 'req-1',
        ip: '198.51.100.10',
        userAgent: 'jest',
        metadata: { reason: 'LOGIN_UNLOCK_REFUSED' },
      },
    ]);
  });

  it('409 en español si la cuenta tiene otra membresía activa en otra clínica: no toca el contador y audita sin email', async () => {
    const s = setup(doctora, new Date(), true);
    const err = await new UnlockStaffLoginUseCase(s.repo, s.locks, s.audit)
      .execute('u1', ctx)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).message).toBe(
      'Esta cuenta da acceso a otra clínica: pide a la persona que espere unos minutos o que restablezca su contraseña',
    );
    expect(LOGIN_UNLOCK_OTHER_CLINIC_MESSAGE).toBe(
      (err as ConflictException).message,
    );
    expect(s.unlock).not.toHaveBeenCalled();
    expect(s.drafts).toHaveLength(1);
    expect(s.drafts[0]).toMatchObject({
      action: 'UPDATE',
      resourceType: 'STAFF_MEMBER',
      resourceId: 'u1',
      metadata: { reason: 'LOGIN_UNLOCK_REFUSED' },
    });
    expect(JSON.stringify(s.drafts)).not.toContain('ana@clinic.com');
  });

  it('es idempotente: desbloquear a quien no está bloqueado no falla', async () => {
    const s = setup(doctora, null);
    await expect(
      new UnlockStaffLoginUseCase(s.repo, s.locks, s.audit).execute('u1', ctx),
    ).resolves.toBeUndefined();
  });
});

describe('GetStaffDetailUseCase: estado del bloqueo (DX-048, DX-213)', () => {
  it('incluye hasta cuándo está bloqueado el inicio de sesión', async () => {
    const until = new Date('2026-10-16T10:15:00Z');
    const { repo, locks, blocked } = setup(doctora, until);
    await expect(
      new GetStaffDetailUseCase(repo, locks).execute('u1'),
    ).resolves.toEqual({ ...doctora, loginBlockedUntil: until });
    expect(blocked).toHaveBeenCalledWith('ana@clinic.com');
  });

  it('null si no está bloqueado', async () => {
    const { repo, locks } = setup(doctora, null);
    await expect(
      new GetStaffDetailUseCase(repo, locks).execute('u1'),
    ).resolves.toEqual({ ...doctora, loginBlockedUntil: null });
  });

  it('null para una membresía desactivada aunque la cuenta esté en espera, sin consultar el contador', async () => {
    const { repo, locks, blocked } = setup(
      desactivada,
      new Date('2026-10-16T10:15:00Z'),
    );
    await expect(
      new GetStaffDetailUseCase(repo, locks).execute('u1'),
    ).resolves.toEqual({ ...desactivada, loginBlockedUntil: null });
    expect(blocked).not.toHaveBeenCalled();
  });

  it('un miembro activo con acceso a otra clínica sigue viendo su espera (solo se le niega el desbloqueo)', async () => {
    const until = new Date('2026-10-16T10:15:00Z');
    const { repo, locks } = setup(doctora, until, true);
    await expect(
      new GetStaffDetailUseCase(repo, locks).execute('u1'),
    ).resolves.toEqual({ ...doctora, loginBlockedUntil: until });
  });

  it('404 si no es miembro de la clínica', async () => {
    const { repo, locks } = setup(null, null);
    await expect(
      new GetStaffDetailUseCase(repo, locks).execute('u1'),
    ).rejects.toThrow(NotFoundException);
  });
});
