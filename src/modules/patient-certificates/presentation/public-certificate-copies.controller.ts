import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiConflictResponse,
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
import { GetPublicCertificateCopyUseCase } from '../application/certificate-copies.use-cases';
import { PublicCertificateCopyDto } from './dto/patient-certificate.dto';
import { presentPublicCopy } from './patient-certificate.presenter';

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
  'Token mal formado, inexistente, de otra clínica, invalidado al reenviar o del paciente archivado (el mismo 404 genérico).';
const GONE =
  'El enlace caducó (`CERTIFICATE_COPY_LINK_EXPIRED`): hay que pedir otro a la clínica.';

// PÚBLICO (DX-306) — sin JwtAuthGuard: quien abre el enlace es el paciente o
// el responsable de un menor. El tenant sale SOLO del host
// (PublicTenantContextInterceptor, DX-207); la RLS hace invisible un token de
// otra clínica. Mismos límites que las copias de DX-443 y DX-468. `no-store`:
// anular el certificado se ve en la siguiente carga.
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
@RateLimit('copy-link', 'copy-token')
@ApiTooManyRequestsResponse({ description: 'Demasiadas peticiones' })
@Controller('public/certificate-copies')
export class PublicCertificateCopiesController {
  constructor(private readonly copies: GetPublicCertificateCopyUseCase) {}

  @Get(':token')
  @ApiOperation({
    summary: 'El paciente abre la copia de su certificado',
    description:
      'Con el enlace vivo: el certificado tal como se imprime (fechas con la zona y el formato de la sede). Si se anuló después del envío, solo «anulado» y el día. Cada apertura queda en la auditoría de la clínica como VIEW de PATIENT_CERTIFICATE, origen PUBLIC_LINK, reason CERTIFICATE_COPY_OPENED.',
  })
  @ApiOkResponse({ type: PublicCertificateCopyDto })
  @ApiGoneResponse({ description: GONE })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  async get(
    @Param('token') token: string,
    @Req() req: TenantHostRequest & { ip?: string },
  ): Promise<PublicCertificateCopyDto> {
    return presentPublicCopy(await this.copies.view(token, requestMeta(req)));
  }

  @Get(':token/pdf')
  @ApiOperation({
    summary: 'El paciente descarga el PDF de su certificado',
    description:
      'Solo de un certificado vigente. Queda en la auditoría como EXPORT de PATIENT_CERTIFICATE, origen PUBLIC_LINK, reason CERTIFICATE_COPY_DOWNLOADED.',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({
    description: 'El PDF (attachment).',
    schema: { type: 'string', format: 'binary' },
  })
  @ApiGoneResponse({ description: GONE })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: 'El certificado fue anulado' })
  async pdf(
    @Param('token') token: string,
    @Req() req: TenantHostRequest & { ip?: string },
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const result = await this.copies.pdf(token, requestMeta(req));
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
