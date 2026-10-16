import {
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
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  TREATMENT_PLAN_DECISION_ROLES,
  TREATMENT_PLAN_QUOTE_READ_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import type { JwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import {
  AcceptTreatmentPlanUseCase,
  GetPlanQuoteUseCase,
  type PlanQuoteDocument,
} from '../application/use-cases/plan-quote.use-cases';
import {
  AcceptTreatmentPlanDto,
  PlanQuoteDocumentDto,
} from './dto/plan-quote.dto';
import { Audit } from '../../audit/presentation/audit.decorator';

type AuthenticatedRequest = Request & { user: JwtPayload };

const USER_AGENT_MAX = 512;

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description:
    'Sede cuyos datos encabezan el presupuesto (y en la que se firma). Sin ella, la sede principal. Un plan ya aceptado muestra la sede en la que se firmó.',
};

/** La firma sale como data URL, lista para un `<img>`; nunca IP ni UA. */
function toDto(doc: PlanQuoteDocument): PlanQuoteDocumentDto {
  return {
    ...doc,
    acceptance: doc.acceptance
      ? {
          ...doc.acceptance,
          signature: `data:image/png;base64,${doc.acceptance.signature}`,
        }
      : null,
  };
}

// Presupuesto imprimible y aceptación firmada (DX-012). Sin @Patch ni @Delete
// A PROPÓSITO: una aceptación firmada es inmutable (trigger de la base,
// 20261016213000_treatment_plan_acceptances).
@ApiTags('treatment-plans')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@ApiParam({ name: 'patientId', format: 'uuid' })
@ApiParam({ name: 'planId', format: 'uuid' })
@ApiHeader(LOCATION_HEADER)
@Controller('patients/:patientId/treatment-plans/:planId')
export class PlanQuoteController {
  constructor(
    private readonly getQuote: GetPlanQuoteUseCase,
    private readonly acceptPlan: AcceptTreatmentPlanUseCase,
  ) {}

  @Audit({
    action: 'PRINT',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: { param: 'patientId' },
  })
  @Get('quote')
  @Roles(...TREATMENT_PLAN_QUOTE_READ_ROLES)
  @ApiOkResponse({ type: PlanQuoteDocumentDto })
  @ApiNotFoundResponse({
    description:
      'Paciente o plan no encontrados en esta clínica (o el plan es de otro paciente)',
  })
  async quote(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
  ): Promise<PlanQuoteDocumentDto> {
    return toDto(await this.getQuote.execute(patientId, planId));
  }

  @Audit({
    action: 'SIGN',
    resource: 'TREATMENT_PLAN',
    resourceId: { param: 'planId' },
    patient: { param: 'patientId' },
  })
  @Post('acceptance')
  @Roles(...TREATMENT_PLAN_DECISION_ROLES)
  @ApiCreatedResponse({
    type: PlanQuoteDocumentDto,
    description:
      'Plan aceptado: ACCEPTED, sus ítems propuestos pasan a aceptados y quedan congelados; las demás opciones abiertas de su grupo pasan a REJECTED (otra opción aceptada) en la misma transacción',
  })
  @ApiBadRequestResponse({
    description:
      'Sin firma, firma no PNG o de más de 200 KB, sin nombre de quien firma, o plan sin ítems',
  })
  @ApiNotFoundResponse({
    description: 'Paciente o plan no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'Ya estaba aceptado y firmado, el plan está rechazado, cancelado o completado, otra opción de su grupo ya está aceptada, o el presupuesto cambió desde que se mostró (contentHash)',
  })
  @ApiForbiddenResponse({
    description:
      'Solo odontólogo y ADMIN aceptan (DX-040): la asistente lo ve pero no lo acepta; recepción imprime el presupuesto pero no lo acepta',
  })
  async accept(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('planId', ParseUUIDPipe) planId: string,
    @Body() dto: AcceptTreatmentPlanDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PlanQuoteDocumentDto> {
    const userAgent = req.get('user-agent');
    const doc = await this.acceptPlan.execute(
      patientId,
      planId,
      {
        signerName: dto.signerName,
        signature: dto.signature,
        contentHash: dto.contentHash,
      },
      {
        acceptedById: req.user.sub,
        ipAddress: req.ip ?? null,
        userAgent: userAgent ? userAgent.slice(0, USER_AGENT_MAX) : null,
      },
    );
    return toDto(doc);
  }
}
