import { Controller, Get, Param, Req, UseInterceptors } from '@nestjs/common';
import {
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { GetPublicPrescriptionCopyUseCase } from '../application/use-cases/prescription-copies.use-cases';
import { PublicPrescriptionCopyDto } from './dto/prescription-copy.dto';
import { presentPublicPrescriptionCopy } from './prescription.presenter';

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

// PÚBLICO (DX-468) — sin JwtAuthGuard: quien abre el enlace es el paciente o
// el responsable de un menor. El tenant sale SOLO del host
// (PublicTenantContextInterceptor, invariante de DX-207); la RLS hace
// invisible un token de otra clínica. Mismos límites que la copia del PDF
// firmado (DX-443): por IP y por token. `no-store`: anular la receta se ve en
// la siguiente carga, nunca una respuesta cacheada.
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
@RateLimit('copy-link', 'copy-token')
@ApiTooManyRequestsResponse({ description: 'Demasiadas peticiones' })
@Controller('public/prescription-copies')
export class PublicPrescriptionCopiesController {
  constructor(private readonly getCopy: GetPublicPrescriptionCopyUseCase) {}

  @Get(':token')
  @ApiOperation({
    summary: 'El paciente abre la copia de su receta',
    description:
      'Copia INFORMATIVA (no la receta electrónica oficial). Con el enlace vivo: la receta emitida con su código de verificación (DX-467) y el pie de la clínica; si se anuló después del envío, solo «anulada» y el día, sin receta. Cada apertura queda en la auditoría de la clínica como VIEW de PRESCRIPTION, origen PUBLIC_LINK, reason PRESCRIPTION_COPY_OPENED.',
  })
  @ApiOkResponse({ type: PublicPrescriptionCopyDto })
  @ApiGoneResponse({
    description:
      'El enlace caducó (`PRESCRIPTION_COPY_LINK_EXPIRED`): hay que pedir otro a la clínica.',
  })
  @ApiNotFoundResponse({
    description:
      'Token mal formado, inexistente, de otra clínica, invalidado al reenviar o del paciente archivado (el mismo 404 genérico).',
  })
  async get(
    @Param('token') token: string,
    @Req() req: TenantHostRequest & { ip?: string },
  ): Promise<PublicPrescriptionCopyDto> {
    return presentPublicPrescriptionCopy(
      await this.getCopy.execute(token, requestMeta(req)),
    );
  }
}
