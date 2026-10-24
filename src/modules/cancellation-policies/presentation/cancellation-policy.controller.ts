import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ClinicRole } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreateCancellationPolicyVersionUseCase,
  GetCancellationPolicyUseCase,
  type CancellationPolicyView,
} from '../application/use-cases/cancellation-policy.use-cases';
import {
  CANCELLATION_POLICY_MESSAGES,
  type CancellationPolicyVersion,
} from '../domain/cancellation-policy';
import {
  CancellationPolicyDto,
  CancellationPolicyVersionDto,
  CreateCancellationPolicyDto,
} from './dto/cancellation-policy.dto';

const locationIdPipe = new ParseUUIDPipe({
  exceptionFactory: () =>
    new BadRequestException(CANCELLATION_POLICY_MESSAGES.invalidLocationId),
});

/**
 * Ajustes → Sedes → «Política de cancelación» (DX-279). Solo ADMIN, para leer
 * y para escribir. Guardar crea la versión siguiente (la tabla es
 * append-only) y queda auditado.
 */
@ApiTags('cancellation-policies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.ADMIN)
@RolesDeniedMessage(CANCELLATION_POLICY_MESSAGES.forbidden)
@Controller('locations/:id/cancellation-policy')
export class CancellationPolicyController {
  constructor(
    private readonly getPolicy: GetCancellationPolicyUseCase,
    private readonly createVersion: CreateCancellationPolicyVersionUseCase,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'Política de cancelación de la sede: la vigente y su historial',
  })
  @ApiOkResponse({ type: CancellationPolicyDto })
  @ApiBadRequestResponse({
    description: CANCELLATION_POLICY_MESSAGES.invalidLocationId,
  })
  @ApiForbiddenResponse({ description: CANCELLATION_POLICY_MESSAGES.forbidden })
  @ApiNotFoundResponse({ description: 'Sede no encontrada en esta clínica' })
  get(
    @Param('id', locationIdPipe) id: string,
  ): Promise<CancellationPolicyView> {
    return this.getPolicy.execute(id);
  }

  @Audit({
    action: 'CREATE',
    resource: 'CANCELLATION_POLICY',
    resourceId: { response: 'id' },
    reason: 'CANCELLATION_POLICY_CHANGED',
  })
  @Post()
  @ApiOperation({
    summary: 'Guardar la política de la sede (crea la versión siguiente)',
    description:
      'La versión anterior no cambia: queda en el historial como prueba de lo que se comunicó al paciente. Horas de aviso 0–168; importe sugerido ≥ 0 con su moneda (los dos o ninguno); texto para el paciente de hasta 1000 caracteres. Queda en la auditoría (CANCELLATION_POLICY, CANCELLATION_POLICY_CHANGED, con los campos enviados).',
  })
  @ApiCreatedResponse({ type: CancellationPolicyVersionDto })
  @ApiBadRequestResponse({
    description:
      'Horas fuera de 0–168, importe negativo o sin moneda, moneda desconocida o texto de más de 1000 caracteres (mensaje en español)',
  })
  @ApiForbiddenResponse({ description: CANCELLATION_POLICY_MESSAGES.forbidden })
  @ApiNotFoundResponse({ description: 'Sede no encontrada en esta clínica' })
  create(
    @Param('id', locationIdPipe) id: string,
    @Body() dto: CreateCancellationPolicyDto,
    @Req() req: { user: JwtPayload },
  ): Promise<CancellationPolicyVersion> {
    return this.createVersion.execute(
      id,
      {
        noticeHours: dto.noticeHours,
        suggestedFee: dto.suggestedFee ?? null,
        currency: dto.currency ?? null,
        patientText: dto.patientText ?? '',
        receptionCanCharge: dto.receptionCanCharge,
      },
      req.user.sub,
    );
  }
}
