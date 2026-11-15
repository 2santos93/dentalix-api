import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiGoneResponse,
  ApiNoContentResponse,
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
import {
  CreatePaymentProofUploadDto,
  PaymentProofUploadDto,
} from '../../payments/presentation/dto/payment-proof.dto';
import type { ProofUploadTicket } from '../../payments/application/payment-proof-uploads';
import {
  AuthorizePaymentLinkProofUploadUseCase,
  CompletePaymentLinkProofUploadUseCase,
  GetPublicPaymentLinkUseCase,
  MarkPaymentLinkOpenedUseCase,
  SubmitPaymentReportUseCase,
  type PublicPaymentLinkView,
} from '../application/use-cases/public-payment-links.use-cases';
import {
  CompletePaymentLinkProofDto,
  PaymentReportedDto,
  PublicPaymentLinkDto,
  PublicStagedProofDto,
  SubmitPaymentReportDto,
} from './dto/payment-link.dto';

const NOT_FOUND =
  'Token desconocido, mal formado, caducado, anulado, de un paciente archivado o de otra clínica (el mismo 404).';
const GONE =
  'El enlace ya se usó: `{ code: PAYMENT_LINK_USED, status: "REPORTED" }` («Ya recibimos tu reporte»).';

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

// PÚBLICO (DX-569) — sin JwtAuthGuard: quien abre el enlace es el paciente.
// El tenant sale SOLO del host (PublicTenantContextInterceptor, DX-207); la
// RLS hace invisible un token de otra clínica (→ 404 genérico). no-store y
// no-referrer en todas las respuestas.
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
// Por IP y por token: frena la enumeración y el martilleo de un enlace.
@RateLimit('payment-link', 'payment-link-token')
@ApiNotFoundResponse({ description: NOT_FOUND })
@ApiGoneResponse({ description: GONE })
@Controller('public/payment-links')
export class PublicPaymentLinksController {
  constructor(
    private readonly getLink: GetPublicPaymentLinkUseCase,
    private readonly markOpened: MarkPaymentLinkOpenedUseCase,
    private readonly authorizeUpload: AuthorizePaymentLinkProofUploadUseCase,
    private readonly completeUpload: CompletePaymentLinkProofUploadUseCase,
    private readonly submitReport: SubmitPaymentReportUseCase,
  ) {}

  // SOLO LECTURA: los previsualizadores de enlaces la abren solos.
  @Get(':token')
  @ApiOperation({
    summary: 'El paciente abre su enlace de pago',
    description:
      'DX-569 (D4). Marca y nombre de la clínica, nombre de pila del paciente, concepto genérico («Saldo pendiente» o «Cuota del plan de pagos», sin tratamientos), el importe pedido y su equivalente en las otras monedas de la clínica con la tasa de hoy YA guardada (nunca se pide al proveedor; sin ella, `equivalents` vacío y `equivalentsUnavailable`), y los medios permitidos con sus datos para pagar. Nada clínico.',
  })
  @ApiOkResponse({ type: PublicPaymentLinkDto })
  get(@Param('token') token: string): Promise<PublicPaymentLinkView> {
    return this.getLink.execute(token);
  }

  @Post(':token/opened')
  @HttpCode(204)
  @ApiOperation({
    summary: 'La página avisa de que el paciente la abrió',
    description:
      'Solo la primera vez (`openedAt`); las siguientes no cambian nada. Sin auditoría.',
  })
  @ApiNoContentResponse({ description: 'Apertura registrada (idempotente).' })
  opened(@Param('token') token: string): Promise<void> {
    return this.markOpened.execute(token);
  }

  @Post(':token/proof-upload')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Autorización para subir el comprobante del pago',
    description:
      'DX-569 (D6). La misma subida directa del abono: POST prefirmado de pocos minutos para UN fichero (JPG, PNG, WebP o PDF de 1 B a 10 MB; el HEIC se convierte en el navegador) con el SHA-256 declarado. Como mucho 3 autorizaciones por enlace; una petición que no vale no gasta ninguna.',
  })
  @ApiOkResponse({ type: PaymentProofUploadDto })
  @ApiBadRequestResponse({
    description: 'Tamaño, huella o tipo declarado no válidos, o archivo vacío',
  })
  @ApiConflictResponse({
    description:
      'Ya se autorizaron 3 subidas con este enlace (`code: PAYMENT_LINK_PROOF_UPLOADS_EXHAUSTED`)',
  })
  proofUpload(
    @Param('token') token: string,
    @Body() dto: CreatePaymentProofUploadDto,
  ): Promise<ProofUploadTicket> {
    return this.authorizeUpload.execute(token, {
      name: dto.name,
      mimeType: dto.mimeType,
      size: dto.size,
      sha256: dto.sha256,
    });
  }

  @Post(':token/proof-upload/complete')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Comprueba el comprobante subido y lo prepara para el reporte',
    description:
      'DX-569 (D6). Tipo por contenido, tamaño y huella, como el del abono. Queda como el comprobante del enlace (`proofUploadId` en el reporte); uno anterior se descarta.',
  })
  @ApiOkResponse({ type: PublicStagedProofDto })
  @ApiBadRequestResponse({
    description:
      'El contenido no es JPG, PNG, WebP ni PDF, no coincide con lo declarado o cambió (`code: PAYMENT_PROOF_REJECTED`)',
  })
  proofComplete(
    @Param('token') token: string,
    @Body() dto: CompletePaymentLinkProofDto,
  ): Promise<PublicStagedProofDto> {
    return this.completeUpload.execute(token, dto.uploadId);
  }

  @Post(':token/report')
  @ApiOperation({
    summary: 'El paciente reporta su pago (una sola vez por enlace)',
    description:
      'DX-569 (D5). Medio (uno de los ofrecidos), moneda (de la clínica), importe, referencia (si el medio la pide), día del pago (desde el día del enlace menos 2 hasta hoy en la sede), comprobante (si el medio lo exige) y nota. Un solo reporte por enlace: el segundo, también a la vez, recibe 410. Nace PENDING en la bandeja «Pagos por confirmar». Auditado como CREATE de PAYMENT_REPORT, actor público, origen PUBLIC_LINK.',
  })
  @ApiCreatedResponse({ type: PaymentReportedDto })
  @ApiBadRequestResponse({
    description:
      'Medio no ofrecido, moneda que la clínica no cobra, referencia que falta o es larga, fecha fuera de la ventana, comprobante que falta, sobra o no se subió por este enlace, o nota larga',
  })
  report(
    @Param('token') token: string,
    @Body() dto: SubmitPaymentReportDto,
    @Req() req: TenantHostRequest & { ip?: string },
  ): Promise<PaymentReportedDto> {
    return this.submitReport.execute(
      token,
      {
        paymentMethodId: dto.paymentMethodId,
        currency: dto.currency,
        amount: dto.amount,
        reference: dto.reference,
        paidOn: dto.paidOn,
        proofUploadId: dto.proofUploadId,
        note: dto.note,
      },
      requestMeta(req),
    );
  }
}
