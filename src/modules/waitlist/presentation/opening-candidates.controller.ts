import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
  ApiNotFoundResponse,
  ApiOkResponse,
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
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  CreateWaitlistOfferUseCase,
  ListOpeningCandidatesUseCase,
  RecordWaitlistOfferOutcomeUseCase,
  type OpeningCandidatesView,
  type WaitlistOfferView,
} from '../application/use-cases/opening-candidates.use-cases';
import type { WaitlistOffer } from '../domain/ports/opening-candidates-repository.port';
import {
  OPENING_ASSIGN_FORBIDDEN_MESSAGE,
  OPENING_CANDIDATES_FORBIDDEN_MESSAGE,
} from '../domain/waitlist-offer-rules';
import {
  CreateWaitlistOfferDto,
  CreatedWaitlistOfferDto,
  OpeningCandidatesDto,
  OpeningCandidatesQueryDto,
  RecordWaitlistOfferOutcomeDto,
  WaitlistOfferDto,
} from './dto/opening-candidates.dto';

/**
 * «Ocupar este hueco» (DX-210): candidatos para un hueco libre de la agenda y
 * las ofertas que recepción les hace. Datos personales (nombre y teléfono) y
 * de agenda: solo personal con sesión de clínica y RLS por tenant. Recepción y
 * ADMIN ofrecen; el odontólogo solo ve los candidatos de su columna; la
 * asistente, nada. Asignar un pendiente reutiliza `POST waitlist/:id/schedule`
 * y adelantar una cita, `PATCH appointments/:id/opening`.
 */
@ApiTags('appointments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(ClinicRole.ADMIN, ClinicRole.RECEPTION)
@RolesDeniedMessage(OPENING_ASSIGN_FORBIDDEN_MESSAGE)
@Controller('appointments/openings')
export class OpeningCandidatesController {
  constructor(
    private readonly listCandidates: ListOpeningCandidatesUseCase,
    private readonly createOffer: CreateWaitlistOfferUseCase,
    private readonly recordOutcome: RecordWaitlistOfferOutcomeUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Detrás del RolesGuard siempre hay sesión de clínica y tenant. */
  private ctx(req: AuditableRequest): AuditRequestContext {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return ctx;
  }

  @Get(':locationId/candidates')
  @Roles(ClinicRole.ADMIN, ClinicRole.RECEPTION, ClinicRole.DENTIST)
  @RolesDeniedMessage(OPENING_CANDIDATES_FORBIDDEN_MESSAGE)
  @ApiOkResponse({
    type: OpeningCandidatesDto,
    description:
      'Pendientes OPEN de la sede que caben en el hueco y citas futuras (de un día posterior) marcadas «Adelantar si hay hueco», del profesional del hueco si se indica. Orden: URGENT, resto de pendientes, citas (la más lejana primero) y, a igualdad, la más antigua. Tope de 50.',
  })
  @ApiBadRequestResponse({
    description: 'Hueco al revés, de más de 8 h o ya pasado',
  })
  @ApiForbiddenResponse({
    description:
      'ASSISTANT, o DENTIST pidiendo una columna que no es la suya (o ninguna)',
  })
  @ApiNotFoundResponse({ description: 'Sede o profesional de otra clínica' })
  candidates(
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Query() query: OpeningCandidatesQueryDto,
    @Req() req: AuditableRequest,
  ): Promise<OpeningCandidatesView> {
    const ctx = this.ctx(req);
    return this.listCandidates.execute(
      {
        locationId,
        start: new Date(query.start),
        end: new Date(query.end),
        providerId: query.providerId,
      },
      ctx.actor,
    );
  }

  @Post(':locationId/offers')
  @ApiCreatedResponse({
    type: CreatedWaitlistOfferDto,
    description:
      '«Ofrecer por WhatsApp» o «Llamé»: registra la oferta (auditada) y el paciente queda «ofrecido» para el hueco.',
  })
  @ApiBadRequestResponse({
    description:
      'Hueco inválido o pasado, pendiente y cita a la vez, o resultado en una oferta por WhatsApp',
  })
  @ApiForbiddenResponse({ description: 'Solo RECEPTION y ADMIN' })
  @ApiNotFoundResponse({
    description: 'Sede, profesional, paciente, pendiente o cita ajenos',
  })
  @ApiConflictResponse({
    description:
      'Tope de ofertas del día («Ya se le ofrecieron 2 huecos hoy»), por WhatsApp a un paciente con baja, canal «Ninguno» o sin el permiso de WhatsApp (DX-128), o pendiente/cita que ya no está vigente',
  })
  offer(
    @Param('locationId', ParseUUIDPipe) locationId: string,
    @Body() dto: CreateWaitlistOfferDto,
    @Req() req: AuditableRequest,
  ): Promise<WaitlistOfferView> {
    return this.createOffer.execute(
      {
        locationId,
        slotStart: new Date(dto.slotStart),
        slotEnd: new Date(dto.slotEnd),
        providerId: dto.providerId,
        patientId: dto.patientId,
        waitlistEntryId: dto.waitlistEntryId,
        appointmentId: dto.appointmentId,
        channel: dto.channel,
        outcome: dto.outcome,
      },
      this.ctx(req),
    );
  }

  @Patch('offers/:id')
  @HttpCode(200)
  @ApiOkResponse({
    type: WaitlistOfferDto,
    description: 'Anota la respuesta del paciente a una oferta pendiente.',
  })
  @ApiForbiddenResponse({ description: 'Solo RECEPTION y ADMIN' })
  @ApiNotFoundResponse({ description: 'Oferta no encontrada en esta clínica' })
  @ApiConflictResponse({ description: 'La oferta ya tenía resultado' })
  outcome(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordWaitlistOfferOutcomeDto,
    @Req() req: AuditableRequest,
  ): Promise<WaitlistOffer> {
    return this.recordOutcome.execute(id, dto.outcome, this.ctx(req));
  }
}
