import {
  ForbiddenException,
  Inject,
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DEVICE_DRAFT_KEY_SECRET_ENV,
  DEVICE_DRAFT_KEY_VERSION,
  deriveDeviceDraftKey,
} from '../../../../shared/crypto/device-draft-key';
import type { TenantJwtPayload } from '../../../../shared/crypto/token.service';
import {
  DRAFT_KEY_GATE,
  type DraftKeyGate,
} from '../../domain/ports/draft-key-gate.port';

export const DRAFT_KEY_SESSION_MESSAGE =
  'La sesión ya no es válida para guardar borradores. Vuelve a iniciar sesión.';
export const DRAFT_KEY_BREAK_GLASS_MESSAGE =
  'Un acceso de soporte no guarda borradores en el dispositivo.';
export const DRAFT_KEY_UNCONFIGURED_MESSAGE =
  'Los borradores en el dispositivo no están disponibles en este servidor.';

export interface DeviceDraftKey {
  key: string;
  version: number;
}

/**
 * DX-574: la clave de los borradores cifrados en el dispositivo. El access
 * token por sí solo no basta (se verifica sin BD): además la sesión tiene que
 * estar VIVA en la BD — su familia de refresh sin revocar ni caducar, la
 * `tokenVersion` del token igual a la vigente, la membresía activa en la
 * clínica y la clínica activa. Si algo falla, 401: la web no guarda borradores
 * y descarta los que no pueda descifrar.
 */
@Injectable()
export class GetDeviceDraftKeyUseCase {
  constructor(
    @Inject(DRAFT_KEY_GATE) private readonly gate: DraftKeyGate,
    private readonly config: ConfigService,
  ) {}

  async execute(
    user: TenantJwtPayload & { sid?: string; tv?: number },
  ): Promise<DeviceDraftKey> {
    if (user.breakGlass) {
      throw new ForbiddenException(DRAFT_KEY_BREAK_GLASS_MESSAGE);
    }
    if (!user.sid) throw new UnauthorizedException(DRAFT_KEY_SESSION_MESSAGE);
    const tokenVersion = await this.gate.liveTokenVersion({
      userId: user.sub,
      tenantId: user.tenantId,
      sessionId: user.sid,
    });
    if (tokenVersion === null || tokenVersion !== (user.tv ?? 0)) {
      throw new UnauthorizedException(DRAFT_KEY_SESSION_MESSAGE);
    }
    const secret = this.config.get<string>(DEVICE_DRAFT_KEY_SECRET_ENV)?.trim();
    if (!secret) {
      throw new ServiceUnavailableException(DRAFT_KEY_UNCONFIGURED_MESSAGE);
    }
    return {
      key: deriveDeviceDraftKey(
        secret,
        user.tenantId,
        user.sub,
        tokenVersion,
      ).toString('base64'),
      version: DEVICE_DRAFT_KEY_VERSION,
    };
  }
}
