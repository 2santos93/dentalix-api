import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBadRequestResponse,
  ApiCookieAuth,
  ApiGoneResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import {
  ConfirmPortalAppointmentUseCase,
  GetPatientPortalUseCase,
  VerifyPatientAccessUseCase,
  type PatientAccessPrincipal,
} from '../application/use-cases/public-patient-access.use-cases';
import { PATIENT_ACCESS_COOKIE } from '../domain/patient-access-session';
import {
  PatientAccessSessionDto,
  PatientPortalDto,
  PortalAppointmentConfirmedDto,
  VerifyPatientAccessDto,
} from './dto/patient-access.dto';
import { patientAccessCookieOptions } from './patient-access-cookie';
import { PatientAccessHeadersInterceptor } from './patient-access-headers.interceptor';
import {
  PatientAccessSessionGuard,
  type PatientAccessRequest,
} from './patient-access-session.guard';

type PublicRequest = PatientAccessRequest & { ip?: string };

function requestMeta(req: PublicRequest): AuditRequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    requestId: currentRequestId() ?? null,
    ip: req.ip ?? null,
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
  };
}

function principalOf(req: PatientAccessRequest): PatientAccessPrincipal {
  // El guard siempre la deja; sin ella la ruta no llega aquí.
  return req.patientAccess!;
}

const INVALID =
  '«Datos incorrectos» (code PATIENT_ACCESS_INVALID): token malformado, desconocido, de otra clínica, caducado o revocado, paciente archivado o fecha errónea; la MISMA respuesta y el mismo tiempo para todos.';
const LOCKED =
  'PATIENT_ACCESS_LOCKED con retryAfterSeconds: el quinto fallo bloquea 30 min (también para un token que no existe: no lo revela).';
const SESSION =
  'PATIENT_ACCESS_SESSION_REQUIRED: sin la cookie `dentalix_pa`, con una de otra clínica o caducada.';
const GONE =
  'PATIENT_ACCESS_GONE: la clínica revocó el enlace, caducó o el paciente se archivó (se borra la cookie). Sin ningún dato.';

// PÚBLICO (DX-101) — el portal de solo lectura del paciente. Sin
// JwtAuthGuard: el tenant sale SOLO del host (PublicTenantContextInterceptor)
// y la RLS hace invisible un enlace de otra clínica. La sesión es la cookie
// propia `dentalix_pa` con su propio guard (PatientAccessSessionGuard). Toda
// respuesta, también de error: no-store, no-referrer y noindex.
@ApiTags('public')
@UseInterceptors(
  NoStoreHeadersInterceptor,
  PatientAccessHeadersInterceptor,
  PublicTenantContextInterceptor,
)
@Controller('public/patient-access')
export class PublicPatientAccessController {
  private readonly secure: boolean;

  constructor(
    private readonly verify: VerifyPatientAccessUseCase,
    private readonly portal: GetPatientPortalUseCase,
    private readonly confirm: ConfirmPortalAppointmentUseCase,
    config: ConfigService,
  ) {
    this.secure = config.get<string>('NODE_ENV') === 'production';
  }

  @Post(':token/verify')
  @HttpCode(200)
  @RateLimit('patient-access', 'patient-access-token')
  @ApiOperation({
    summary: 'Verificar la fecha de nacimiento y abrir la sesión (30 min)',
    description:
      'Si la fecha casa con la del paciente del enlace, devuelve 200 y la cookie HttpOnly `dentalix_pa` (SameSite=Strict, Path=/api/v1/public/patient-access). 5 fallos bloquean el enlace 30 min (429). Auditado: el acceso verificado (con los fallos previos agregados) y el bloqueo; nunca la fecha.',
  })
  @ApiOkResponse({ type: PatientAccessSessionDto })
  @ApiBadRequestResponse({ description: INVALID })
  @ApiTooManyRequestsResponse({ description: LOCKED })
  async verifyBirthDate(
    @Param('token') token: string,
    @Body() dto: VerifyPatientAccessDto,
    @Req() req: PublicRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PatientAccessSessionDto> {
    const verified = await this.verify.execute(
      token,
      dto.birthDate,
      requestMeta(req),
    );
    res.cookie(PATIENT_ACCESS_COOKIE, verified.cookieValue, {
      ...patientAccessCookieOptions(this.secure),
      maxAge: Math.max(0, verified.sessionExpiresAt.getTime() - Date.now()),
    });
    return {
      sessionExpiresAt: verified.sessionExpiresAt,
      scopes: verified.scopes,
    };
  }

  @Get('me')
  @UseGuards(PatientAccessSessionGuard)
  @RateLimit('patient-access')
  @ApiCookieAuth(PATIENT_ACCESS_COOKIE)
  @ApiOperation({
    summary: 'Citas, presupuestos y estado de cuenta compartidos',
    description:
      'Solo los apartados del enlace (los demás, null) y solo del paciente del enlace. El estado de cuenta tiene los mismos importes que el del personal (DX-011).',
  })
  @ApiOkResponse({ type: PatientPortalDto })
  @ApiUnauthorizedResponse({ description: SESSION })
  @ApiGoneResponse({ description: GONE })
  me(@Req() req: PatientAccessRequest): Promise<PatientPortalDto> {
    // La vista ya es la proyección de lista blanca (portal-projection.ts).
    return this.portal.execute(principalOf(req));
  }

  @Post('me/appointments/:appointmentId/confirm')
  @HttpCode(200)
  @UseGuards(PatientAccessSessionGuard)
  @RateLimit('patient-access')
  @ApiCookieAuth(PATIENT_ACCESS_COOKIE)
  @ApiOperation({
    summary: 'Confirmar una cita (flujo de DX-005)',
    description:
      'Solo una cita futura y agendada del paciente del enlace, con el apartado de citas compartido. Queda en la auditoría como CONFIRMATION_LINK_CONFIRMED.',
  })
  @ApiOkResponse({ type: PortalAppointmentConfirmedDto })
  @ApiNotFoundResponse({
    description:
      'Cita inexistente, de otro paciente, pasada, ya confirmada o sin el apartado de citas',
  })
  @ApiUnauthorizedResponse({ description: SESSION })
  @ApiGoneResponse({ description: GONE })
  confirmAppointment(
    @Param('appointmentId', ParseUUIDPipe) appointmentId: string,
    @Req() req: PublicRequest,
  ): Promise<PortalAppointmentConfirmedDto> {
    return this.confirm.execute(
      principalOf(req),
      appointmentId,
      requestMeta(req),
    );
  }

  @Post('me/logout')
  @HttpCode(204)
  @RateLimit('patient-access')
  @ApiOperation({ summary: 'Cerrar la sesión del portal (borra la cookie)' })
  @ApiNoContentResponse()
  logout(@Res({ passthrough: true }) res: Response): void {
    res.clearCookie(
      PATIENT_ACCESS_COOKIE,
      patientAccessCookieOptions(this.secure),
    );
  }
}
