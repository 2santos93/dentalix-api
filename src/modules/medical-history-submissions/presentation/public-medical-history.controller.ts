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
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { currentRequestId } from '../../../shared/observability/request-context';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import {
  ANAMNESIS_LINK_GONE_MESSAGE,
  GetPublicAnamnesisUseCase,
  SubmitPublicAnamnesisUseCase,
} from '../application/use-cases/public-anamnesis.use-cases';
import { SubmitPublicAnamnesisDto } from './dto/anamnesis-answers.dto';
import {
  PublicAnamnesisDto,
  PublicAnamnesisSubmittedDto,
} from './dto/public-anamnesis.dto';

interface PublicRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

const NOT_FOUND = 'Token malformado, desconocido o de otra clínica.';

// PÚBLICO (DX-099) — sin JwtAuthGuard: quien abre el enlace es el paciente.
// El tenant sale SOLO del host (PublicTenantContextInterceptor); la RLS hace
// invisible un token de otra clínica (→ 404). Límite por IP (enumeración) y
// por token (reintentos sobre un mismo enlace), un balde por ruta. Sin
// @Audit: el envío se audita en el repositorio, en su transacción, sin las
// respuestas.
@ApiTags('public')
@UseInterceptors(PublicTenantContextInterceptor)
@RateLimit('anamnesis', 'anamnesis-token')
@Controller('public/medical-history')
export class PublicMedicalHistoryController {
  constructor(
    private readonly getAnamnesis: GetPublicAnamnesisUseCase,
    private readonly submitAnamnesis: SubmitPublicAnamnesisUseCase,
  ) {}

  // SOLO LECTURA: los previsualizadores de enlaces la abren solos.
  @Get(':token')
  @ApiOperation({
    summary: 'Cuestionario de anamnesis del enlace (sin datos previos)',
  })
  @ApiOkResponse({ type: PublicAnamnesisDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiGoneResponse({ description: ANAMNESIS_LINK_GONE_MESSAGE })
  get(@Param('token') token: string): Promise<PublicAnamnesisDto> {
    return this.getAnamnesis.execute(token);
  }

  @Post(':token')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Enviar las respuestas (una sola vez; la HC no cambia hasta que se revisa)',
  })
  @ApiOkResponse({ type: PublicAnamnesisSubmittedDto })
  @ApiBadRequestResponse({
    description: 'Respuestas incompletas o sin la declaración de veracidad',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiGoneResponse({
    description: `${ANAMNESIS_LINK_GONE_MESSAGE} (caducado, anulado o ya enviado)`,
  })
  @ApiConflictResponse({
    description: 'La política de datos cambió o no está publicada',
  })
  @ApiUnprocessableEntityResponse({
    description: 'Falta la autorización de datos de salud',
  })
  submit(
    @Param('token') token: string,
    @Body() dto: SubmitPublicAnamnesisDto,
    @Req() req: PublicRequest,
  ): Promise<PublicAnamnesisSubmittedDto> {
    const userAgent = req.headers['user-agent'];
    return this.submitAnamnesis.execute(
      token,
      {
        answers: dto.answers,
        declarationAccepted: dto.declarationAccepted,
        consent: dto.consent,
      },
      {
        ipAddress: req.ip ?? null,
        userAgent:
          (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
        requestId: currentRequestId() ?? null,
      },
    );
  }
}
