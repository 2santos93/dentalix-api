import { Controller, Get, Param, Req, UseInterceptors } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import {
  PRESCRIPTION_VERIFICATION_NOT_FOUND_MESSAGE,
  VerifyPrescriptionUseCase,
  type PublicPrescriptionVerification,
} from '../application/use-cases/public-prescription-verification.use-cases';
import { PublicPrescriptionVerificationDto } from './dto/public-prescription-verification.dto';

function requestMeta(
  req: TenantHostRequest & { ip?: string },
): AuditRequestMeta {
  const userAgent = req.headers['user-agent'];
  return {
    requestId: currentRequestId() ?? null,
    ip: req.ip ?? null,
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
  };
}

// PÚBLICO (DX-467) — sin JwtAuthGuard: quien verifica es un tercero (la
// farmacia) con el código o el QR de la receta impresa. El tenant sale SOLO
// del host (PublicTenantContextInterceptor); la RLS hace invisible el código
// de otra clínica (el mismo 404). Sin caché: tras anularla, la misma URL dice
// «anulada» al momento.
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
// Por IP: frena a quien pruebe códigos al azar (un balde por ruta).
@RateLimit('prescription-verify')
@Controller('public/prescription-verifications')
export class PublicPrescriptionVerificationsController {
  constructor(private readonly verify: VerifyPrescriptionUseCase) {}

  @Get(':code')
  @ApiOperation({
    summary:
      'Verifica una receta con su código (página pública /receta/<código>)',
    description:
      'Dice si la receta es válida (con fecha de emisión, profesional y su registro, clínica e iniciales del paciente), está anulada (solo la fecha) o no se puede verificar porque su hash no coincide. Nunca medicamentos, diagnóstico ni documento del paciente. Acepta el código en minúsculas o con guiones. Cada verificación de una receta encontrada queda en la auditoría como VIEW de PRESCRIPTION, origen PUBLIC_LINK, sin actor, con reason PRESCRIPTION_VERIFIED, PRESCRIPTION_VERIFIED_VOIDED o PRESCRIPTION_INTEGRITY_MISMATCH.',
  })
  @ApiParam({ name: 'code', example: 'K7M2P9QRT4XW' })
  @ApiOkResponse({ type: PublicPrescriptionVerificationDto })
  @ApiNotFoundResponse({
    description: `Código mal formado, inexistente, de otra clínica o host sin clínica: el mismo 404 genérico («${PRESCRIPTION_VERIFICATION_NOT_FOUND_MESSAGE}»).`,
  })
  get(
    @Param('code') code: string,
    @Req() req: TenantHostRequest & { ip?: string },
  ): Promise<PublicPrescriptionVerification> {
    return this.verify.execute(code, requestMeta(req));
  }
}
