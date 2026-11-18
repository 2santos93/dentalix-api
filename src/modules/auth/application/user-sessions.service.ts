import {
  BadRequestException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { TokenService } from '../../../shared/crypto/token.service';
import {
  auditDraftFromContext,
  type AuditRequestContext,
  type AuditRequestMeta,
} from '../../audit/domain/audit-request-context';
import type { AuditEventDraft } from '../../audit/domain/audit-event';
import { trustedDeviceLabel } from '../domain/user-mfa';
import {
  parseDurationMs,
  SESSION_ALERT_TTL_HOURS,
  SESSION_MESSAGES,
  type SessionRevocationReason,
  type UserSessionView,
  deviceFingerprint,
  isSessionIdle,
  isValidSessionIdleMinutes,
  shouldNotifyNewDevice,
  truncateIp,
} from '../domain/user-sessions';
import {
  USER_SESSIONS_REPOSITORY,
  type ClinicSessionRecord,
  type SessionSelection,
  type UserSessionsRepository,
} from '../domain/ports/user-sessions-repository.port';
import {
  NEW_LOGIN_NOTIFIER,
  type NewLoginNotifier,
} from '../domain/ports/new-login-notifier.port';
import {
  generatePasswordResetToken,
  hashPasswordResetToken,
  passwordResetExpiresAt,
} from './password-reset-token';

export const USER_SESSIONS_CLOCK = Symbol('USER_SESSIONS_CLOCK');

/** Un par recién emitido y desde dónde se pidió. */
export interface OpenedSession {
  refreshToken: string;
  userId: string;
  /** Clínica del host (`null` = plataforma). */
  tenantId: string | null;
  ip: string | null;
  userAgent: string | null;
  /**
   * `LOGIN`: un inicio de sesión (contraseña, segundo factor): se comprueba si
   * el dispositivo es nuevo y, si toca, se avisa. `CONTINUATION`: la misma
   * persona en el mismo navegador recibe un par nuevo (cambio de contraseña,
   * activar el MFA, aceptar una invitación): se recuerda el dispositivo sin
   * avisar.
   */
  kind: 'LOGIN' | 'CONTINUATION';
}

/** Sesión de clínica que pide la lista (o cierra una de las suyas). */
export interface SessionActor extends AuditRequestContext {
  /** `sid` del access token que hace la petición (`null` si no lo lleva). */
  currentSessionId: string | null;
}

/** Lo que devuelve «No fui yo»: el enlace de restablecimiento, si cabe. */
export interface NotMeResult {
  /** Token del enlace `/restablecer/<token>` (`null` = ya no es miembro). */
  passwordResetToken: string | null;
}

function hashAlertToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Token del enlace «No fui yo»: 32 bytes aleatorios en base64url. */
const ALERT_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * DX-137: sesiones visibles y cerrables, aviso de inicio de sesión nuevo y
 * «No fui yo». Ver `domain/user-sessions.ts`.
 *
 * Privacidad: en la BD, en la respuesta y en la auditoría de estas acciones
 * solo viajan el navegador y sistema resumidos y la IP truncada.
 */
@Injectable()
export class UserSessionsService {
  private readonly logger = new Logger('UserSessions');
  private readonly clock: () => Date;
  private readonly accessTtlMs: number;

  constructor(
    @Inject(USER_SESSIONS_REPOSITORY)
    private readonly repo: UserSessionsRepository,
    private readonly tokens: TokenService,
    @Inject(NEW_LOGIN_NOTIFIER) private readonly notifier: NewLoginNotifier,
    config: ConfigService,
    @Optional() @Inject(USER_SESSIONS_CLOCK) clock?: () => Date,
  ) {
    this.clock = clock ?? (() => new Date());
    this.accessTtlMs = parseDurationMs(config.get<string>('JWT_ACCESS_TTL'));
  }

  /**
   * Registra la familia recién emitida con su dispositivo y, en un LOGIN de
   * clínica, avisa si el dispositivo es nuevo. El aviso nunca tumba el login:
   * si falla, queda en el log (sin email ni IP).
   */
  async open(session: OpenedSession): Promise<void> {
    const { sid, jti, expiresAt, tokenVersion } = this.tokens.refreshClaims(
      session.refreshToken,
    );
    const deviceLabel = trustedDeviceLabel(session.userAgent);
    const ipPrefix = truncateIp(session.ip);
    await this.repo.openSession({
      sid,
      userId: session.userId,
      jti,
      expiresAt,
      tokenVersion,
      deviceLabel,
      ipPrefix,
      tenantId: session.tenantId,
    });
    // Plataforma: sin clínica que firme el aviso ni enlace que la sirva.
    if (session.tenantId === null) return;
    try {
      await this.rememberDevice({
        tenantId: session.tenantId,
        userId: session.userId,
        sid,
        deviceLabel,
        ipPrefix,
        notify: session.kind === 'LOGIN',
      });
    } catch (err) {
      this.logger.warn({
        event: 'user_sessions.new_login_check_failed',
        tenantId: session.tenantId,
        userId: session.userId,
        error: err instanceof Error ? err.constructor.name : typeof err,
      });
    }
  }

  private async rememberDevice(input: {
    tenantId: string;
    userId: string;
    sid: string;
    deviceLabel: string;
    ipPrefix: string | null;
    notify: boolean;
  }): Promise<void> {
    const now = this.clock();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(
      now.getTime() + SESSION_ALERT_TTL_HOURS * 3_600_000,
    );
    const alerted = await this.repo.rememberDevice({
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sid,
      fingerprint: deviceFingerprint(
        input.userId,
        input.deviceLabel,
        input.ipPrefix,
      ),
      now,
      decide: (state) =>
        input.notify && shouldNotifyNewDevice({ ...state, now })
          ? { tokenHash: hashAlertToken(token), expiresAt }
          : null,
    });
    if (!alerted) return;
    const recipient = await this.repo.findRecipient(input.userId);
    if (!recipient) return;
    await this.notifier.send({
      tenantId: input.tenantId,
      userId: input.userId,
      to: recipient.email,
      userName: recipient.fullName,
      deviceLabel: input.deviceLabel,
      ipPrefix: input.ipPrefix,
      at: now,
      token,
      expiresInHours: SESSION_ALERT_TTL_HOURS,
    });
    this.logger.log({
      event: 'user_sessions.new_login_notified',
      tenantId: input.tenantId,
      userId: input.userId,
    });
  }

  /** Sesiones vivas de `userId` en la clínica, la más reciente primero. */
  async list(
    tenantId: string,
    userId: string,
    currentSessionId: string | null,
  ): Promise<UserSessionView[]> {
    const now = this.clock();
    const idleMinutes = await this.repo.clinicIdleMinutes(tenantId);
    const rows = await this.repo.listClinicSessions(tenantId, userId, now);
    return rows
      .filter((row) => !this.idle(row, now, idleMinutes))
      .map((row) => ({
        id: row.id,
        deviceLabel: row.deviceLabel ?? trustedDeviceLabel(null),
        ipPrefix: row.ipPrefix,
        firstSeenAt: row.createdAt,
        lastSeenAt: row.lastSeenAt ?? row.createdAt,
        current: row.id === currentSessionId,
      }))
      .sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          b.lastSeenAt.getTime() - a.lastSeenAt.getTime(),
      );
  }

  /**
   * Una sesión ya inactiva sigue en la BD hasta su próximo refresh (que la
   * revoca): no se lista. Sin margen de access: lo que se ve en la lista es
   * lo que el cliente consideraría vivo.
   */
  private idle(row: ClinicSessionRecord, now: Date, idleMinutes: number) {
    return isSessionIdle({
      lastActivityAt: row.lastSeenAt ?? row.createdAt,
      now,
      idleMinutes,
      // El margen de un access token: el mismo que el del refresh, para que
      // la lista nunca oculte una sesión que aún puede renovarse.
      accessTtlMs: this.accessTtlMs,
    });
  }

  /** Cierre por inactividad de la clínica, en minutos. */
  idleMinutes(tenantId: string): Promise<number> {
    return this.repo.clinicIdleMinutes(tenantId);
  }

  /**
   * Cambia el cierre por inactividad de la clínica (solo ADMIN, lo exige la
   * ruta). Auditado (CLINIC_SETTINGS, `SESSION_IDLE_POLICY`) con el antes y el
   * después; sin evento si no cambia. Se aplica en el siguiente refresh de
   * cada sesión y en la web al recargar «Mi perfil» o la sesión.
   */
  async setIdleMinutes(
    minutes: number,
    ctx: AuditRequestContext,
  ): Promise<number> {
    if (!isValidSessionIdleMinutes(minutes)) {
      throw new BadRequestException(SESSION_MESSAGES.idleRange);
    }
    const before = await this.repo.clinicIdleMinutes(ctx.tenantId);
    if (before === minutes) return minutes;
    await this.repo.setClinicIdleMinutes(
      ctx.tenantId,
      minutes,
      auditDraftFromContext(ctx, {
        action: 'UPDATE',
        resourceType: 'CLINIC_SETTINGS',
        resourceId: null,
        metadata: {
          reason: 'SESSION_IDLE_POLICY',
          statusChange: {
            from: `IDLE_${before}_MIN`,
            to: `IDLE_${minutes}_MIN`,
          },
        },
      }),
    );
    return minutes;
  }

  /** Cierra UNA sesión propia (también la actual: equivale a salir). */
  async revokeOwn(actor: SessionActor, sessionId: string): Promise<void> {
    const closed = await this.revoke(
      actor,
      actor.actor.userId,
      { kind: 'one', sessionId },
      'SESSION_REVOKED_BY_SELF',
      sessionId,
    );
    if (closed === 0) throw new NotFoundException(SESSION_MESSAGES.notFound);
  }

  /** Cierra todas las sesiones propias en la clínica salvo la actual. */
  async revokeOwnOthers(actor: SessionActor): Promise<number> {
    return this.revoke(
      actor,
      actor.actor.userId,
      { kind: 'all-except', sessionId: actor.currentSessionId },
      'OTHER_SESSIONS_REVOKED',
      null,
    );
  }

  /** ADMIN: sesiones de un miembro de SU clínica (404 si no lo es). */
  async listForMember(
    actor: SessionActor,
    targetUserId: string,
  ): Promise<UserSessionView[]> {
    await this.assertMember(actor.tenantId, targetUserId);
    return this.list(
      actor.tenantId,
      targetUserId,
      actor.actor.userId === targetUserId ? actor.currentSessionId : null,
    );
  }

  /** ADMIN: cierra una sesión de un miembro de su clínica. */
  async revokeForMember(
    actor: SessionActor,
    targetUserId: string,
    sessionId: string,
  ): Promise<void> {
    await this.assertMember(actor.tenantId, targetUserId);
    const closed = await this.revoke(
      actor,
      targetUserId,
      { kind: 'one', sessionId },
      'SESSION_REVOKED_BY_ADMIN',
      sessionId,
    );
    if (closed === 0) throw new NotFoundException(SESSION_MESSAGES.notFound);
  }

  /** ADMIN: cierra todas las sesiones de un miembro en su clínica. */
  async revokeAllForMember(
    actor: SessionActor,
    targetUserId: string,
  ): Promise<number> {
    await this.assertMember(actor.tenantId, targetUserId);
    return this.revoke(
      actor,
      targetUserId,
      {
        kind: 'all-except',
        // Nunca la propia sesión con la que el ADMIN lo pide.
        sessionId:
          actor.actor.userId === targetUserId ? actor.currentSessionId : null,
      },
      'MEMBER_SESSIONS_REVOKED_BY_ADMIN',
      null,
    );
  }

  private async assertMember(tenantId: string, userId: string): Promise<void> {
    if (!(await this.repo.activeMemberRole(tenantId, userId))) {
      throw new NotFoundException(SESSION_MESSAGES.memberNotFound);
    }
  }

  private revoke(
    actor: SessionActor,
    targetUserId: string,
    selection: SessionSelection,
    reason: SessionRevocationReason,
    resourceId: string | null,
  ): Promise<number> {
    return this.repo.revokeClinicSessions({
      tenantId: actor.tenantId,
      userId: targetUserId,
      selection,
      now: this.clock(),
      audit: (sessionsClosed) =>
        sessionAudit(actor, {
          resourceId,
          reason,
          sessionsClosed,
          targetUserId:
            targetUserId === actor.actor.userId ? null : targetUserId,
        }),
    });
  }

  /**
   * «No fui yo» (público, en el host de la clínica del aviso). Un enlace que
   * no vale da siempre el mismo error, sin decir de quién es ni por qué.
   */
  async notMe(
    tenantId: string,
    token: string,
    request: AuditRequestMeta,
  ): Promise<NotMeResult> {
    if (!ALERT_TOKEN_SHAPE.test(token)) {
      throw new NotFoundException(SESSION_MESSAGES.alertInvalid);
    }
    const now = this.clock();
    const resetToken = generatePasswordResetToken();
    const outcome = await this.repo.consumeSessionAlert({
      tenantId,
      tokenHash: hashAlertToken(token),
      now,
      passwordReset: {
        tokenHash: hashPasswordResetToken(resetToken),
        expiresAt: passwordResetExpiresAt(now),
      },
      audit: ({ userId, role, sessionsClosed }) =>
        sessionAudit(
          {
            tenantId,
            locationId: null,
            actor: { userId, role },
            ...request,
          },
          {
            resourceId: null,
            reason: 'SESSION_NOT_ME',
            sessionsClosed,
            targetUserId: null,
          },
        ),
    });
    if (!outcome) throw new NotFoundException(SESSION_MESSAGES.alertInvalid);
    this.logger.warn({
      event: 'user_sessions.not_me',
      tenantId,
      userId: outcome.userId,
      sessionsClosed: outcome.sessionsClosed,
    });
    return { passwordResetToken: outcome.role ? resetToken : null };
  }
}

/**
 * Evento SESSION/DELETE de estas acciones. Con la IP TRUNCADA y el navegador
 * resumido (DX-137): nunca la IP completa ni el user-agent en bruto.
 */
function sessionAudit(
  ctx: AuditRequestContext,
  event: {
    resourceId: string | null;
    reason: SessionRevocationReason;
    sessionsClosed: number;
    targetUserId: string | null;
  },
): AuditEventDraft {
  const draft = auditDraftFromContext(
    {
      ...ctx,
      ip: truncateIp(ctx.ip),
      userAgent: ctx.userAgent ? trustedDeviceLabel(ctx.userAgent) : null,
    },
    {
      action: 'DELETE',
      resourceType: 'SESSION',
      resourceId: event.resourceId,
      metadata: {
        reason: event.reason,
        sessionsClosed: event.sessionsClosed,
        ...(event.targetUserId
          ? { params: { userId: event.targetUserId } }
          : {}),
      },
    },
  );
  return draft;
}
