import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { contentDispositionHeader } from '../../../shared/storage/file-storage.port';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import { PublicExternalOrderCopyUseCase } from '../application/external-order-copies.use-cases';
import { PublicExternalOrderCopyDto } from './dto/external-order.dto';
import { presentPublicCopy } from './external-order.presenter';

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

const NOT_FOUND =
  'Token mal formado, inexistente, de otra clínica, caducado, invalidado (reenvío, orden anulada o paciente archivado): el mismo 404 genérico.';

// PÚBLICO (DX-572) — sin JwtAuthGuard: quien abre el enlace es el paciente o
// el responsable de un menor. El tenant sale SOLO del host
// (PublicTenantContextInterceptor, DX-207); la RLS hace invisible un token de
// otra clínica. Mismos límites que las copias de DX-443, DX-468 y DX-306.
// `no-store`: un enlace usado o invalidado se ve en la siguiente carga.
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
@RateLimit('copy-link', 'copy-token')
@ApiTooManyRequestsResponse({ description: 'Demasiadas peticiones' })
@Controller('public/external-order-copies')
export class PublicExternalOrderCopiesController {
  constructor(private readonly copies: PublicExternalOrderCopyUseCase) {}

  @Get(':token')
  @ApiOperation({
    summary: 'El paciente abre el enlace de la copia de su orden',
    description:
      'NO gasta el enlace. AVAILABLE (se puede descargar una vez) o USED, con los datos mínimos: clínica, número, tipo y fecha. Cada apertura queda en la auditoría como VIEW de EXTERNAL_ORDER, origen PUBLIC_LINK, reason EXTERNAL_ORDER_COPY_OPENED.',
  })
  @ApiOkResponse({ type: PublicExternalOrderCopyDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  async get(
    @Param('token') token: string,
    @Req() req: TenantHostRequest & { ip?: string },
  ): Promise<PublicExternalOrderCopyDto> {
    return presentPublicCopy(await this.copies.view(token, requestMeta(req)));
  }

  @Post(':token/download')
  @HttpCode(200)
  @ApiOperation({
    summary: 'El paciente descarga el PDF de su orden y gasta el enlace',
    description:
      'Una sola vez: el PDF con la nota clínica (es del paciente). Queda en la auditoría como EXPORT de EXTERNAL_ORDER, origen PUBLIC_LINK, reason EXTERNAL_ORDER_COPY_DOWNLOADED.',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description: 'El PDF (attachment).',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiGoneResponse({
    description:
      'El enlace ya se usó (`EXTERNAL_ORDER_COPY_LINK_USED`): hay que pedir otro a la clínica.',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  async download(
    @Param('token') token: string,
    @Req() req: TenantHostRequest & { ip?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const result = await this.copies.download(token, requestMeta(req));
    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      contentDispositionHeader({
        disposition: 'attachment',
        filename: result.fileName,
      }),
    );
    return new StreamableFile(result.pdf);
  }
}
