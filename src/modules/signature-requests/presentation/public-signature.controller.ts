import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import { NoStoreHeadersInterceptor } from '../../medical-history-submissions/presentation/no-store-headers.interceptor';
import type { PublicRequestEvidence } from '../domain/ports/signature-request-repository.port';
import {
  GetPublicSignatureDocumentUseCase,
  GetPublicSignatureUseCase,
  RequestSignatureCodeUseCase,
  SIGNATURE_LINK_INVALID_MESSAGE,
  SignPublicSignatureUseCase,
  VerifySignatureCodeUseCase,
} from '../application/use-cases/public-signature.use-cases';
import {
  PublicSignatureDocumentDto,
  PublicSignatureDto,
  PublicSignedCopyDto,
  SignPublicSignatureDto,
  SignatureSessionDto,
  VerifySignatureCodeDto,
} from './dto/public-signature.dto';

interface PublicRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

const INVALID = `«${SIGNATURE_LINK_INVALID_MESSAGE}»: token malformado, desconocido, de otra clínica, caducado, usado, anulado o bloqueado (la misma respuesta para todos).`;
const SESSION_HEADER = 'x-signature-session';

function evidenceOf(req: PublicRequest): PublicRequestEvidence {
  const userAgent = req.headers['user-agent'];
  return {
    ipAddress: req.ip ?? null,
    userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
    requestId: currentRequestId() ?? null,
  };
}

const SessionHeader = ApiHeader({
  name: 'X-Signature-Session',
  required: true,
  description: 'La sesión que devolvió POST …/verify',
});

// PÚBLICO (DX-243) — sin JwtAuthGuard: quien abre el enlace es el paciente (o
// su responsable). El tenant sale SOLO del host (PublicTenantContextInterceptor);
// la RLS hace invisible un token de otra clínica (→ 404, igual que uno
// inventado). Límite por IP (enumeración) y por token (reintentos sobre un
// mismo enlace), un balde por ruta, como la anamnesis (DX-099). Los pasos se
// auditan en el repositorio, en su transacción. `no-store` y `no-referrer`
// en toda respuesta, también de error.
@ApiTags('public')
@UseInterceptors(NoStoreHeadersInterceptor, PublicTenantContextInterceptor)
@RateLimit('signature', 'signature-token')
@Controller('public/sign')
export class PublicSignatureController {
  constructor(
    private readonly getSignature: GetPublicSignatureUseCase,
    private readonly requestCode: RequestSignatureCodeUseCase,
    private readonly verifyCode: VerifySignatureCodeUseCase,
    private readonly getDocument: GetPublicSignatureDocumentUseCase,
    private readonly signDocument: SignPublicSignatureUseCase,
  ) {}

  // SOLO LECTURA: los previsualizadores de enlaces lo abren solos.
  @Get(':token')
  @ApiOperation({
    summary: 'Estado mínimo del enlace (sin documento ni datos del paciente)',
  })
  @ApiOkResponse({ type: PublicSignatureDto })
  @ApiNotFoundResponse({ description: INVALID })
  get(@Param('token') token: string): Promise<PublicSignatureDto> {
    return this.getSignature.execute(token);
  }

  @Post(':token/code')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Pedir (o reenviar) el código de 6 dígitos al destino del enlace',
    description:
      'La primera vez cuenta como apertura. Hasta 5 envíos, con 60 s entre uno y otro (429 con retryAfterSeconds). Pedir otro código no devuelve intentos.',
  })
  @ApiOkResponse({ type: PublicSignatureDto })
  @ApiNotFoundResponse({ description: INVALID })
  @ApiServiceUnavailableResponse({ description: 'No se pudo encolar el email' })
  code(
    @Param('token') token: string,
    @Req() req: PublicRequest,
  ): Promise<PublicSignatureDto> {
    return this.requestCode.execute(token, evidenceOf(req));
  }

  @Post(':token/verify')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verificar el código (5 fallos bloquean el enlace)',
  })
  @ApiOkResponse({ type: SignatureSessionDto })
  @ApiBadRequestResponse({
    description:
      'SIGNATURE_CODE_INVALID (con attemptsLeft), SIGNATURE_CODE_EXPIRED o SIGNATURE_LINK_LOCKED (el quinto fallo)',
  })
  @ApiNotFoundResponse({ description: INVALID })
  verify(
    @Param('token') token: string,
    @Body() dto: VerifySignatureCodeDto,
    @Req() req: PublicRequest,
  ): Promise<SignatureSessionDto> {
    return this.verifyCode.execute(token, dto.code, evidenceOf(req));
  }

  @Get(':token/document')
  @SessionHeader
  @ApiOperation({ summary: 'El documento completo (tras verificar el código)' })
  @ApiOkResponse({ type: PublicSignatureDocumentDto })
  @ApiForbiddenResponse({
    description: 'SIGNATURE_SESSION_REQUIRED: falta la sesión o caducó',
  })
  @ApiNotFoundResponse({ description: INVALID })
  document(
    @Param('token') token: string,
    @Headers(SESSION_HEADER) session: string | undefined,
  ): Promise<PublicSignatureDocumentDto> {
    return this.getDocument.execute(token, session);
  }

  @Post(':token/sign')
  @HttpCode(200)
  @SessionHeader
  @ApiOperation({
    summary: 'Firmar (una sola vez)',
    description:
      'Guarda la firma en el consentimiento con su hash y las evidencias (canal, destino enmascarado, horas, IP, navegador). Queda pendiente de la firma del profesional en la app.',
  })
  @ApiOkResponse({ type: PublicSignedCopyDto })
  @ApiBadRequestResponse({
    description:
      'Firma en blanco, no PNG o de más de 200 KB; sin confirmar la lectura; falta el documento del responsable',
  })
  @ApiForbiddenResponse({
    description: 'SIGNATURE_SESSION_REQUIRED: falta la sesión o caducó',
  })
  @ApiNotFoundResponse({ description: INVALID })
  sign(
    @Param('token') token: string,
    @Headers(SESSION_HEADER) session: string | undefined,
    @Body() dto: SignPublicSignatureDto,
    @Req() req: PublicRequest,
  ): Promise<PublicSignedCopyDto> {
    return this.signDocument.execute(
      token,
      session,
      {
        signature: dto.signature,
        signerDocument: dto.signerDocument,
        accepted: dto.accepted,
      },
      evidenceOf(req),
    );
  }
}
