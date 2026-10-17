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
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { PublicTenantContextInterceptor } from '../../../shared/tenancy/public-tenant-context.interceptor';
import { currentRequestId } from '../../../shared/observability/request-context';
import {
  ConfirmPublicOptOutUseCase,
  GetPublicOptOutUseCase,
} from '../application/use-cases/reminder-opt-out.use-cases';
import { PublicReminderOptOutDto } from './dto/public-reminder-opt-out.dto';

interface PublicRequest {
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

// PÚBLICO — sin JwtAuthGuard: quien abre el enlace es el paciente, desde el
// email de recordatorio (DX-128). Igual que la confirmación de DX-005: el
// tenant sale SOLO del host y la RLS hace invisible un token de otra clínica
// (→ 404). Mismo límite por IP que la confirmación (frena la enumeración).
@ApiTags('public')
@UseInterceptors(PublicTenantContextInterceptor)
@RateLimit('confirmation')
@Controller('public/reminder-opt-outs')
export class PublicReminderOptOutsController {
  constructor(
    private readonly getOptOut: GetPublicOptOutUseCase,
    private readonly confirmOptOut: ConfirmPublicOptOutUseCase,
  ) {}

  // SOLO LECTURA: abrir el enlace no da de baja (antivirus y
  // previsualizadores de correo abren los enlaces solos).
  @Get(':token')
  @ApiOperation({ summary: 'Ver el enlace de baja de los recordatorios' })
  @ApiOkResponse({ type: PublicReminderOptOutDto })
  @ApiNotFoundResponse({ description: 'Token desconocido o de otra clínica.' })
  get(@Param('token') token: string): Promise<PublicReminderOptOutDto> {
    return this.getOptOut.execute(token);
  }

  @Post(':token')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Darse de baja de los recordatorios (idempotente)',
    description:
      'Registra la baja del paciente (`reminderOptOutAt`, origen LINK) y la audita sin actor. Repetirlo responde lo mismo sin escribir.',
  })
  @ApiOkResponse({ type: PublicReminderOptOutDto })
  @ApiNotFoundResponse({ description: 'Token desconocido o de otra clínica.' })
  confirm(
    @Param('token') token: string,
    @Req() req: PublicRequest,
  ): Promise<PublicReminderOptOutDto> {
    const userAgent = req.headers['user-agent'];
    return this.confirmOptOut.execute(token, {
      ip: req.ip ?? null,
      userAgent: (Array.isArray(userAgent) ? userAgent[0] : userAgent) ?? null,
      requestId: currentRequestId() ?? null,
    });
  }
}
