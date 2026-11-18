import {
  Body,
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
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { NoStoreHeadersInterceptor } from '../../../shared/http/no-store-headers.interceptor';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { contentDispositionHeader } from '../../../shared/storage/file-storage.port';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import {
  COMMISSION_RECEIPT_LINK_INVALID_MESSAGE,
  CommissionReceiptPublicUseCases,
} from '../application/commission-receipt-public.use-cases';
import type { PublicReceiptView } from '../domain/commission-receipt';
import {
  PublicCommissionReceiptDto,
  SignCommissionReceiptDto,
} from './dto/commission-payment.dto';

interface PublicRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

const INVALID = `«${COMMISSION_RECEIPT_LINK_INVALID_MESSAGE}»: token malformado, desconocido, de otra clínica, caducado, revocado o de un pago anulado (la misma respuesta para todos).`;
const PDF_SCHEMA = { type: 'string', format: 'binary' } as const;

// PÚBLICO (DX-464) — sin JwtAuthGuard: quien abre el enlace es el
// profesional. El tenant sale SOLO del host (PublicTenantContextInterceptor);
// la RLS hace invisible un token de otra clínica (→ 404, igual que uno
// inventado). Mismos baldes que la firma a distancia (DX-243): por IP y por
// token. `no-store` y `no-referrer` en toda respuesta. Sin datos clínicos
// más allá de las iniciales del paciente y el procedimiento liquidado.
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
@RateLimit('signature', 'signature-token')
@ApiNotFoundResponse({ description: INVALID })
@Controller('public/commission-receipts')
export class PublicCommissionReceiptsController {
  constructor(private readonly receipts: CommissionReceiptPublicUseCases) {}

  // SOLO LECTURA: los previsualizadores de enlaces lo abren solos.
  @Get(':token')
  @ApiOperation({
    summary: 'El recibo del pago de honorarios que el profesional va a firmar',
  })
  @ApiOkResponse({ type: PublicCommissionReceiptDto })
  get(@Param('token') token: string): Promise<PublicReceiptView> {
    return this.receipts.get(token);
  }

  @Post(':token/opened')
  @HttpCode(204)
  @ApiOperation({
    summary: 'La página avisa de que el profesional la abrió',
    description: 'Solo la primera vez; las siguientes no cambian nada.',
  })
  @ApiNoContentResponse({ description: 'Apertura registrada (idempotente).' })
  opened(@Param('token') token: string): Promise<void> {
    return this.receipts.opened(token);
  }

  @Post(':token/sign')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Firmar «recibido conforme» (una sola vez)',
    description:
      'Guarda el nombre, la firma, la IP, el navegador y la huella SHA-256 (recibo + nombre + firma); la hora la pone la BD. El PDF firmado queda adjunto al pago.',
  })
  @ApiOkResponse({ type: PublicCommissionReceiptDto })
  @ApiBadRequestResponse({
    description:
      'Nombre de 2 a 120 caracteres; firma en blanco, no PNG o de más de 200 KB; sin confirmar «recibido conforme»',
  })
  @ApiConflictResponse({
    description: '`COMMISSION_RECEIPT_ALREADY_SIGNED`',
  })
  sign(
    @Param('token') token: string,
    @Body() dto: SignCommissionReceiptDto,
    @Req() req: PublicRequest,
  ): Promise<PublicReceiptView> {
    const userAgent = req.headers['user-agent'];
    return this.receipts.sign(
      token,
      {
        signerName: dto.signerName,
        signature: dto.signature,
        accepted: dto.accepted,
      },
      {
        ipAddress: req.ip ?? null,
        userAgent:
          (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
      },
    );
  }

  @Get(':token/pdf')
  @ApiOperation({
    summary: 'La copia firmada del recibo (mientras el enlace no caduque)',
  })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'El PDF (attachment).', schema: PDF_SCHEMA })
  async pdf(
    @Param('token') token: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const result = await this.receipts.pdf(token);
    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      contentDispositionHeader({
        disposition: 'attachment',
        filename: result.filename,
      }),
    );
    return new StreamableFile(result.pdf);
  }
}
