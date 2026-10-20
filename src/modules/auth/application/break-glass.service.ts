import {
  Inject,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClinicRole } from '@prisma/client';
import { TokenService } from '../../../shared/crypto/token.service';
import {
  MFA_SECRET_CIPHER,
  MfaSecretCipher,
} from '../../../shared/crypto/mfa-secret-cipher';
import { decodeBase32, matchTotp } from '../../../shared/crypto/totp';
import {
  BREAK_GLASS_REPOSITORY,
  type BreakGlassRepository,
} from '../domain/ports/break-glass-repository.port';
import {
  breakGlassChallenge,
  breakGlassMfaCooldownMinutes,
  breakGlassTtlMinutes,
} from '../domain/break-glass';
import { LoginLockoutService } from './login-lockout.service';

const MAX_USER_AGENT = 512;
const MAX_IP = 64;

export interface BreakGlassInput {
  tenantId: string;
  /** Superadmin YA autenticado con su contraseña. */
  user: { id: string; tokenVersion: number };
  mfaCode?: string;
  reason?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface BreakGlassSession {
  accessToken: string;
  breakGlass: true;
  expiresAt: Date;
}

/**
 * SEC-008: abre la sesión de soporte de un superadmin en una clínica donde no
 * es miembro. Se llama SOLO después de verificar su contraseña; ver
 * `domain/break-glass.ts` para las reglas.
 */
@Injectable()
export class BreakGlassService {
  private readonly logger = new Logger('BreakGlass');
  private readonly ttlSeconds: number;
  private readonly cooldownMs: number;

  constructor(
    @Inject(BREAK_GLASS_REPOSITORY) private readonly repo: BreakGlassRepository,
    @Inject(MFA_SECRET_CIPHER) private readonly cipher: MfaSecretCipher,
    private readonly tokens: TokenService,
    private readonly lockout: LoginLockoutService,
    config: ConfigService,
  ) {
    this.ttlSeconds =
      breakGlassTtlMinutes(config.get<string>('BREAK_GLASS_TTL_MINUTES')) * 60;
    this.cooldownMs =
      breakGlassMfaCooldownMinutes(
        config.get<string>('BREAK_GLASS_MFA_COOLDOWN_MINUTES'),
      ) * 60_000;
  }

  async open(input: BreakGlassInput): Promise<BreakGlassSession> {
    const mfa = await this.repo.findMfa(input.user.id);
    if (!mfa?.secretEnc || !mfa.enabledAt) {
      throw breakGlassChallenge('MFA_NOT_ENROLLED');
    }
    const now = Date.now();
    // Espera de seguridad tras el alta (ver domain/break-glass.ts): ni
    // siquiera se miran códigos hasta que pase.
    const availableAt = mfa.enabledAt.getTime() + this.cooldownMs;
    if (now < availableAt) {
      throw breakGlassChallenge('MFA_COOLDOWN', {
        availableAt: new Date(availableAt).toISOString(),
      });
    }

    const reason = input.reason?.trim();
    const code = input.mfaCode?.trim();
    if (!code || !reason) throw breakGlassChallenge('BREAK_GLASS_REQUIRED');

    // Fuerza bruta del código: contador propio por superadmin, que un login
    // correcto (apex) no borra. En espera → LoginLockedError (429).
    await this.lockout.claimMfaAttempt(input.user.id);
    const secret = decodeBase32(
      this.cipher.decrypt(mfa.secretEnc, input.user.id),
    );
    const step = matchTotp(secret, code, now, mfa.lastUsedStep);
    // Código erróneo o reutilizado: el 401 genérico de siempre (y el fallo
    // cuenta para el bloqueo por intentos, DX-048: frena la fuerza bruta).
    if (
      step === null ||
      !(await this.repo.consumeTotpStep(input.user.id, step))
    ) {
      throw new UnauthorizedException('Invalid credentials');
    }
    await this.lockout.clearMfa(input.user.id);

    const { accessToken, expiresAt } = await this.tokens.issueAccessOnly(
      {
        sub: input.user.id,
        tenantId: input.tenantId,
        role: ClinicRole.ADMIN,
        tv: input.user.tokenVersion,
        breakGlass: true,
        // Sin `loc` (DX-089): como todo ADMIN, opera en todas las sedes.
      },
      this.ttlSeconds,
    );
    // Sin fila de auditoría no hay token: si el INSERT falla, la petición
    // falla y el token firmado se descarta.
    await this.repo.recordAccess({
      tenantId: input.tenantId,
      userId: input.user.id,
      reason,
      ip: input.ip?.slice(0, MAX_IP) || null,
      userAgent: input.userAgent?.slice(0, MAX_USER_AGENT) || null,
      // El `iat` firmado: así expiresAt − createdAt es exactamente el TTL.
      createdAt: new Date(expiresAt.getTime() - this.ttlSeconds * 1000),
      expiresAt,
    });
    // Sin el motivo (texto libre): solo ids, como el resto del log.
    this.logger.warn(
      `Break-glass access: user=${input.user.id} tenant=${input.tenantId} until=${expiresAt.toISOString()}`,
    );
    return { accessToken, breakGlass: true, expiresAt };
  }
}
