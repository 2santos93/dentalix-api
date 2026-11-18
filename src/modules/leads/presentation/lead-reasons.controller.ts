import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
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
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  LEAD_ADMIN_ROLES,
  LEAD_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { Audit } from '../../audit/presentation/audit.decorator';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { LeadsUseCases } from '../application/leads.use-cases';
import { LEAD_MESSAGES, type LeadReasonKindCode } from '../domain/lead-rules';
import {
  CreateLeadReasonDto,
  LeadReasonDto,
  LeadReasonsQueryDto,
} from './dto/leads.dto';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

// Motivos de prospectos (DX-556): de interés y de pérdida. Leerlos (para los
// selectores): ADMIN y recepción. Crear y retirar los propios: solo ADMIN,
// auditado SIN `resourceId` (el id de un motivo no es el de un prospecto).
// Los predefinidos son constantes y no se tocan; los prospectos guardan el
// texto (una foto), así que retirar uno no cambia los ya registrados.
@ApiTags('leads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...LEAD_ADMIN_ROLES)
@Controller('lead-reasons')
export class LeadReasonsController {
  constructor(private readonly leads: LeadsUseCases) {}

  @Get()
  @Roles(...LEAD_ROLES)
  @ApiOperation({
    summary: 'Motivos de prospectos: predefinidos y propios vivos',
  })
  @ApiOkResponse({ type: [LeadReasonDto] })
  @ApiForbiddenResponse({ description: 'Solo ADMIN y recepción' })
  list(@Query() dto: LeadReasonsQueryDto): Promise<
    {
      id: string | null;
      kind: LeadReasonKindCode;
      name: string;
      predefined: boolean;
    }[]
  > {
    return this.leads.reasons(dto.kind);
  }

  @Audit({ action: 'CREATE', resource: 'LEAD', reason: 'LEAD_REASON_ADDED' })
  @Post()
  @ApiOperation({ summary: 'Crear un motivo propio (solo ADMIN)' })
  @ApiCreatedResponse({ type: LeadReasonDto })
  @ApiBadRequestResponse({ description: 'Nombre fuera de 2–60 caracteres' })
  @ApiConflictResponse({ description: LEAD_MESSAGES.reasonTaken })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async create(
    @Body() dto: CreateLeadReasonDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<{
    id: string | null;
    kind: LeadReasonKindCode;
    name: string;
    predefined: boolean;
  }> {
    const created = await this.leads.createReason(
      dto.kind,
      dto.name,
      req.user.sub,
    );
    return { ...created, predefined: false };
  }

  @Audit({ action: 'DELETE', resource: 'LEAD', reason: 'LEAD_REASON_REMOVED' })
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Retirar un motivo propio (borrado lógico, solo ADMIN)',
    description: 'Los prospectos que lo usan conservan el texto.',
  })
  @ApiNoContentResponse({ description: 'Retirado.' })
  @ApiNotFoundResponse({ description: LEAD_MESSAGES.reasonNotFound })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.leads.deleteReason(id);
  }
}
