import {
  CanActivate,
  ExecutionContext,
  HttpStatus,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import {
  PATIENT_ACCESS_SESSION_REQUIRED_CODE,
  PATIENT_ACCESS_SESSION_REQUIRED_MESSAGE,
  isLinkLive,
} from '../domain/patient-access';
import {
  PATIENT_ACCESS_COOKIE,
  readCookie,
  verifyPatientAccessSession,
} from '../domain/patient-access-session';
import {
  PATIENT_ACCESS_REPOSITORY,
  type PatientAccessRepository,
} from '../domain/ports/patient-access-repository.port';
import {
  PATIENT_ACCESS_CLOCK,
  PATIENT_ACCESS_SESSION_KEY,
  type PatientAccessClock,
} from '../application/patient-access-clock';
import {
  linkGone,
  type PatientAccessPrincipal,
} from '../application/use-cases/public-patient-access.use-cases';
import { patientAccessCookieOptions } from './patient-access-cookie';
import { setPatientAccessHeaders } from './patient-access-headers.interceptor';

export type PatientAccessRequest = TenantHostRequest & {
  patientAccess?: PatientAccessPrincipal;
};

function sessionRequired(): UnauthorizedException {
  return new UnauthorizedException({
    statusCode: HttpStatus.UNAUTHORIZED,
    error: 'Unauthorized',
    code: PATIENT_ACCESS_SESSION_REQUIRED_CODE,
    message: PATIENT_ACCESS_SESSION_REQUIRED_MESSAGE,
  });
}

/**
 * DX-101: el guard del portal del paciente, separado del del personal. Solo
 * mira la cookie `dentalix_pa` (nunca un Bearer): el token del personal no
 * abre el portal y la cookie del portal no abre ninguna ruta del personal
 * (JwtAuthGuard solo lee `Authorization`).
 *
 * En CADA petición: firma de ESTA clínica (la del host) y sin caducar → si no,
 * 401; luego relee el enlace bajo RLS: revocado, caducado o con el paciente
 * archivado → 410 y se borra la cookie. Revocar corta así la sesión abierta en
 * la siguiente petición. Deja en la petición solo el enlace, el paciente y
 * los apartados.
 *
 * Corre antes que los interceptores: fija aquí mismo `no-store`,
 * `no-referrer` y `noindex` para que también los lleven sus 401 y 410.
 */
@Injectable()
export class PatientAccessSessionGuard implements CanActivate {
  private readonly secure: boolean;

  constructor(
    private readonly tenantContext: TenantContextService,
    @Inject(PATIENT_ACCESS_REPOSITORY)
    private readonly repo: PatientAccessRepository,
    @Inject(PATIENT_ACCESS_SESSION_KEY) private readonly sessionKey: Buffer,
    @Inject(PATIENT_ACCESS_CLOCK) private readonly clock: PatientAccessClock,
    config: ConfigService,
  ) {
    this.secure = config.get<string>('NODE_ENV') === 'production';
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<PatientAccessRequest>();
    const res = http.getResponse<Response>();
    setPatientAccessHeaders(res);

    const tenantId = req.tenantHost?.tenantId ?? null;
    const now = this.clock();
    const claims = tenantId
      ? verifyPatientAccessSession(
          this.sessionKey,
          tenantId,
          readCookie(req.headers.cookie, PATIENT_ACCESS_COOKIE),
          now,
        )
      : null;
    if (!tenantId || !claims) throw sessionRequired();

    const link = await this.tenantContext.run(tenantId, () =>
      this.repo.findSessionLink(claims.linkId),
    );
    // Firmada por esta clínica pero sin fila visible: nunca debería pasar.
    if (!link) throw sessionRequired();
    if (!isLinkLive(link, now) || link.patientArchived) {
      res.clearCookie(
        PATIENT_ACCESS_COOKIE,
        patientAccessCookieOptions(this.secure),
      );
      throw linkGone();
    }
    req.patientAccess = {
      linkId: link.id,
      patientId: link.patientId,
      scopes: link.scopes,
      sessionExpiresAt: claims.expiresAt,
    };
    return true;
  }
}
