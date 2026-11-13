import { Controller, Get, Param, Req, UseInterceptors } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { VerifyPublicPrescriptionUseCase } from '../application/use-cases/public-prescription-verification.use-cases';
import { PublicPrescriptionVerificationDto } from './dto/public-prescription-verification.dto';
import { presentPublicVerification } from './prescription.presenter';

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

// PÚBLICO (DX-467) — sin JwtAuthGuard: quien escanea el QR de la receta
// impresa es una farmacia o el paciente. El tenant sale SOLO del host
// (PublicTenantContextInterceptor, invariante de DX-207); la RLS hace
// invisible el código de otra clínica (→ el mismo 404 que uno inventado).
// Límite por IP contra el barrido de códigos. `no-store`: anular una receta
// se ve en la siguiente consulta, nunca una respuesta cacheada.
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
@RateLimit('prescription-verify')
@Controller('public/prescriptions')
export class PublicPrescriptionVerificationController {
  constructor(private readonly verify: VerifyPublicPrescriptionUseCase) {}

  @Get(':code')
  @ApiOperation({
    summary: 'Verificar una receta por su código (el del QR impreso)',
    description:
      'Válida, anulada (solo el día) o «no se puede verificar» si el hash no casa con el contenido. Nada clínico. Cada consulta de una receta encontrada queda en la auditoría de la clínica como VIEW de PRESCRIPTION, origen PUBLIC_LINK, reason PRESCRIPTION_VERIFIED o PRESCRIPTION_INTEGRITY_MISMATCH. Admite el código agrupado con guiones y en minúsculas.',
  })
  @ApiOkResponse({ type: PublicPrescriptionVerificationDto })
  @ApiNotFoundResponse({
    description:
      'Código mal formado, inexistente o de otra clínica, o host sin clínica (el mismo 404 genérico).',
  })
  async get(
    @Param('code') code: string,
    @Req() req: TenantHostRequest & { ip?: string },
  ): Promise<PublicPrescriptionVerificationDto> {
    return presentPublicVerification(
      await this.verify.execute(code, requestMeta(req)),
    );
  }
}
