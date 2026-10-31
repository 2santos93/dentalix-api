import {
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiTooManyRequestsResponse,
} from '@nestjs/swagger';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import type { AuditRequestMeta } from '../../audit/domain/audit-request-context';
import {
  DownloadSignedPdfCopyUseCase,
  GetPublicSignedPdfCopyUseCase,
  type PublicSignedPdfCopyView,
  type SignedPdfCopyDownloadUrl,
} from '../application/signed-pdf-copy.service';
import {
  PublicSignedPdfCopyDto,
  SignedPdfCopyDownloadDto,
} from './dto/public-signed-pdf-copy.dto';

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
  'Token desconocido, mal formado, caducado, invalidado al reenviar o de otra clínica (el mismo 404 genérico).';

// PÚBLICO (DX-443) — sin JwtAuthGuard: quien abre el enlace es el paciente o
// su responsable. El tenant sale SOLO del host (PublicTenantContextInterceptor,
// invariante de DX-207); la RLS hace invisible un token de otra clínica.
@ApiTags('public')
@UseInterceptors(PublicTenantContextInterceptor)
// Por IP y por token: frena la enumeración y el martilleo de un enlace.
@RateLimit('copy-link', 'copy-token')
@ApiTooManyRequestsResponse({ description: 'Demasiadas peticiones' })
@Controller('public/signed-consent-copies')
export class PublicSignedPdfCopiesController {
  constructor(
    private readonly getCopy: GetPublicSignedPdfCopyUseCase,
    private readonly downloadCopy: DownloadSignedPdfCopyUseCase,
  ) {}

  // SOLO LECTURA: los previsualizadores del correo abren el enlace solos y no
  // deben gastarlo. Descargar exige el POST del botón.
  @Get(':token')
  @ApiOperation({
    summary: 'El paciente abre el enlace de su copia del PDF firmado',
    description:
      'Estado del enlace y la marca de la clínica; ni el título del documento ni nada clínico.',
  })
  @ApiOkResponse({ type: PublicSignedPdfCopyDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  get(@Param('token') token: string): Promise<PublicSignedPdfCopyView> {
    return this.getCopy.execute(token);
  }

  @Post(':token/download')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Descarga la copia (una sola vez)',
    description:
      'Gasta el enlace y devuelve una URL firmada de 60 s del PDF archivado (attachment). Queda en la auditoría como EXPORT de CONSENT, origen PUBLIC_LINK, reason SIGNED_PDF_COPY_DOWNLOADED, en la misma transacción. Una segunda vez: 410 `SIGNED_PDF_COPY_LINK_USED` («Este enlace ya se usó»).',
  })
  @ApiOkResponse({ type: SignedPdfCopyDownloadDto })
  @ApiGoneResponse({ description: 'El enlace ya se usó.' })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  download(
    @Param('token') token: string,
    @Req() req: TenantHostRequest & { ip?: string },
  ): Promise<SignedPdfCopyDownloadUrl> {
    return this.downloadCopy.execute(token, requestMeta(req));
  }
}
