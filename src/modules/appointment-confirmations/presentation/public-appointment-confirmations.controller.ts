import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiGoneResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import { GetPublicConfirmationUseCase } from '../application/use-cases/get-public-confirmation.use-case';
import { RespondConfirmationUseCase } from '../application/use-cases/respond-confirmation.use-case';
import {
  PublicAppointmentConfirmationDto,
  RespondAppointmentConfirmationDto,
} from './dto/appointment-confirmation.dto';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';

// PÚBLICO — sin JwtAuthGuard: quien abre el enlace es el paciente. El tenant
// sale SOLO del host (PublicTenantContextInterceptor + TenantHostMiddleware),
// igual que public-branding e invitaciones; la RLS hace invisible un token de
// otra clínica (→ 404).
@ApiTags('public')
@UseInterceptors(PublicTenantContextInterceptor)
// Por IP: frena la enumeración de tokens. Ver y responder cuentan en baldes
// separados (uno por ruta).
@RateLimit('confirmation')
@Controller('public/appointment-confirmations')
export class PublicAppointmentConfirmationsController {
  constructor(
    private readonly getConfirmation: GetPublicConfirmationUseCase,
    private readonly respondConfirmation: RespondConfirmationUseCase,
  ) {}

  // SOLO LECTURA: abrir el enlace no cambia nada (los previsualizadores de
  // WhatsApp lo abren solos). Responder exige el POST del segundo clic.
  @Get(':token')
  @ApiOkResponse({ type: PublicAppointmentConfirmationDto })
  @ApiNotFoundResponse({ description: 'Token desconocido o de otra clínica.' })
  get(
    @Param('token') token: string,
  ): Promise<PublicAppointmentConfirmationDto> {
    return this.getConfirmation.execute(token);
  }

  @Post(':token')
  @HttpCode(200)
  @ApiOkResponse({ type: PublicAppointmentConfirmationDto })
  @ApiNotFoundResponse({ description: 'Token desconocido o de otra clínica.' })
  @ApiConflictResponse({ description: 'El enlace ya se usó para responder.' })
  @ApiGoneResponse({
    description: 'El enlace caducó o la cita cambió desde que se envió.',
  })
  respond(
    @Param('token') token: string,
    @Body() dto: RespondAppointmentConfirmationDto,
  ): Promise<PublicAppointmentConfirmationDto> {
    return this.respondConfirmation.execute(token, dto.action);
  }
}
