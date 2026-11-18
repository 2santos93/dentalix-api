import { Injectable } from '@nestjs/common';
import { ClinicRole, Prisma, UserTokenPurpose } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import type {
  ClinicSessionRecord,
  ConsumeSessionAlertInput,
  NotMeOutcome,
  OpenSessionInput,
  RememberDeviceInput,
  RevokeClinicSessionsInput,
  UserSessionsRepository,
} from '../../domain/ports/user-sessions-repository.port';
import { SESSION_IDLE_DEFAULT_MINUTES } from '../../domain/user-sessions';

/**
 * DX-137. `refresh_sessions`, `user_login_devices`, `users` y `user_tokens`
 * son tablas GLOBALES (sin RLS); `clinic_sessions` y `session_alerts` son de
 * CLÍNICA (RLS FORCE). Todo lo que toca una fila de clínica corre dentro de
 * `runWithTenant` con el tenant del token o del host: una sesión de otra
 * clínica no existe para esta (404), y eso lo garantiza la BD, no un filtro.
 */
@Injectable()
export class PrismaUserSessionsRepository implements UserSessionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async openSession(input: OpenSessionInput): Promise<void> {
    const session = {
      id: input.sid,
      userId: input.userId,
      currentJti: input.jti,
      expiresAt: input.expiresAt,
      tokenVersion: input.tokenVersion,
      deviceLabel: input.deviceLabel,
      ipPrefix: input.ipPrefix,
    };
    if (input.tenantId === null) {
      await this.prisma.refreshSession.create({ data: session });
      return;
    }
    await this.prisma.runWithTenant(input.tenantId, async (tx) => {
      await tx.refreshSession.create({ data: session });
      await tx.clinicSession.create({
        data: { sessionId: input.sid, tenantId: input.tenantId! },
      });
    });
  }

  async rememberDevice(input: RememberDeviceInput): Promise<boolean> {
    return this.prisma.runWithTenant(input.tenantId, async (tx) => {
      // Dos logins a la vez del mismo usuario se serializan aquí: el segundo
      // ve la huella que dejó el primero y no envía otro email.
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtextextended(${`dx137:login-device:${input.userId}`}, 0))`;
      const devices = await tx.userLoginDevice.findMany({
        where: { userId: input.userId },
        select: { fingerprint: true, lastSeenAt: true },
      });
      const mine = devices.find((d) => d.fingerprint === input.fingerprint);
      const alert = input.decide({
        lastSeenAt: mine?.lastSeenAt ?? null,
        hasOtherKnownDevices: devices.some(
          (d) => d.fingerprint !== input.fingerprint,
        ),
      });
      await tx.userLoginDevice.upsert({
        where: {
          userId_fingerprint: {
            userId: input.userId,
            fingerprint: input.fingerprint,
          },
        },
        create: {
          userId: input.userId,
          fingerprint: input.fingerprint,
          firstSeenAt: input.now,
          lastSeenAt: input.now,
        },
        update: { lastSeenAt: input.now },
      });
      if (!alert) return false;
      await tx.sessionAlert.create({
        data: {
          tenantId: input.tenantId,
          userId: input.userId,
          sessionId: input.sessionId,
          tokenHash: alert.tokenHash,
          expiresAt: alert.expiresAt,
          createdAt: input.now,
        },
      });
      return true;
    });
  }

  async listClinicSessions(
    tenantId: string,
    userId: string,
    now: Date,
  ): Promise<ClinicSessionRecord[]> {
    // `users` es global: la versión vigente (un cambio de contraseña o de MFA
    // la sube y deja muertas las familias anteriores sin tocar su fila).
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { tokenVersion: true },
    });
    if (!user) return [];
    const rows = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicSession.findMany({
        where: {
          tenantId,
          session: {
            userId,
            revokedAt: null,
            expiresAt: { gt: now },
            tokenVersion: user.tokenVersion,
          },
        },
        select: {
          session: {
            select: {
              id: true,
              userId: true,
              deviceLabel: true,
              ipPrefix: true,
              createdAt: true,
              lastSeenAt: true,
            },
          },
        },
      }),
    );
    return rows.map((r) => r.session);
  }

  async revokeClinicSessions(
    input: RevokeClinicSessionsInput,
  ): Promise<number> {
    return this.prisma.runWithTenant(input.tenantId, async (tx) => {
      const selection = input.selection;
      // Las familias de la clínica (RLS) del usuario que siguen vivas.
      const rows = await tx.clinicSession.findMany({
        where: {
          tenantId: input.tenantId,
          ...(selection.kind === 'one'
            ? { sessionId: selection.sessionId }
            : selection.sessionId
              ? { sessionId: { not: selection.sessionId } }
              : {}),
          session: {
            userId: input.userId,
            revokedAt: null,
            expiresAt: { gt: input.now },
          },
        },
        select: { sessionId: true },
      });
      if (rows.length === 0) return 0;
      const { count } = await tx.refreshSession.updateMany({
        where: {
          id: { in: rows.map((r) => r.sessionId) },
          userId: input.userId,
          revokedAt: null,
        },
        data: { revokedAt: input.now },
      });
      if (count > 0) await writeAuditEvent(tx, input.audit(count));
      return count;
    });
  }

  async activeMemberRole(
    tenantId: string,
    userId: string,
  ): Promise<ClinicRole | null> {
    const membership = await this.prisma.runWithTenant(tenantId, (tx) =>
      tx.clinicMembership.findFirst({
        where: { tenantId, userId, deletedAt: null, user: { deletedAt: null } },
        select: { role: true },
      }),
    );
    return membership?.role ?? null;
  }

  async consumeSessionAlert(
    input: ConsumeSessionAlertInput,
  ): Promise<NotMeOutcome | null> {
    return this.prisma.runWithTenant(input.tenantId, async (tx) => {
      // Un solo uso: gana una petición (check-and-set) y la guarda de la BD
      // impide volver a tocar la fila.
      const used = await tx.$queryRaw<{ userId: string }[]>(Prisma.sql`
        UPDATE "session_alerts"
           SET "usedAt" = ${input.now}
         WHERE "tokenHash" = ${input.tokenHash}
           AND "usedAt" IS NULL
           AND "expiresAt" > ${input.now}
        RETURNING "userId"`);
      const userId = used[0]?.userId;
      if (!userId) return null;
      // Todas las sesiones, en TODAS las clínicas: incrementar la versión deja
      // muertos todos los refresh (y los dispositivos de confianza); revocar
      // las familias las saca además de la lista.
      await tx.user.update({
        where: { id: userId },
        data: { tokenVersion: { increment: 1 } },
      });
      const { count: sessionsClosed } = await tx.refreshSession.updateMany({
        where: { userId, revokedAt: null, expiresAt: { gt: input.now } },
        data: { revokedAt: input.now },
      });
      const membership = await tx.clinicMembership.findFirst({
        where: {
          tenantId: input.tenantId,
          userId,
          deletedAt: null,
          user: { deletedAt: null },
        },
        select: { role: true },
      });
      const role = membership?.role ?? null;
      // Un enlace de restablecimiento que pidió quien entró deja de valer; el
      // nuevo lo envía el caso de uso al email de la cuenta.
      await tx.userToken.updateMany({
        where: {
          userId,
          purpose: UserTokenPurpose.PASSWORD_RESET,
          invalidatedAt: null,
        },
        data: { invalidatedAt: input.now },
      });
      const outcome = { userId, role, sessionsClosed };
      await writeAuditEvent(tx, input.audit(outcome));
      return outcome;
    });
  }

  async clinicIdleMinutes(tenantId: string): Promise<number> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { sessionIdleMinutes: true },
    });
    return tenant?.sessionIdleMinutes ?? SESSION_IDLE_DEFAULT_MINUTES;
  }

  async setClinicIdleMinutes(
    tenantId: string,
    minutes: number,
    audit: AuditEventDraft,
  ): Promise<void> {
    await this.prisma.runWithTenant(tenantId, async (tx) => {
      await tx.tenant.update({
        where: { id: tenantId },
        data: { sessionIdleMinutes: minutes },
      });
      await writeAuditEvent(tx, audit);
    });
  }

  async findRecipient(
    userId: string,
  ): Promise<{ email: string; fullName: string } | null> {
    return this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      select: { email: true, fullName: true },
    });
  }
}
