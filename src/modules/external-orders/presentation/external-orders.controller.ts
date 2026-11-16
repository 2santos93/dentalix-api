import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
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
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import type { Response } from 'express';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { contentDispositionHeader } from '../../../shared/storage/file-storage.port';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { TenantHostRequest } from '../../../shared/tenancy/tenant-host-request';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  auditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import {
  EXTERNAL_ORDER_CONFIG_READ_ROLES,
  EXTERNAL_ORDER_CONFIG_WRITE_ROLES,
  EXTERNAL_ORDER_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { SendExternalOrderCopyUseCase } from '../application/external-order-copies.use-cases';
import {
  ExternalOrderSettingsUseCases,
  ExternalOrdersUseCases,
} from '../application/external-orders.use-cases';
import { EXTERNAL_ORDER_COPY_SENT_REASON } from '../domain/external-order-copy-link';
import { EXTERNAL_ORDER_MESSAGES } from '../domain/external-order-rules';
import type { ExternalOrderSettings } from '../domain/ports/external-order-repository.port';
import {
  ExternalOrderCopySentDto,
  ExternalOrderDto,
  ExternalOrderPdfQueryDto,
  ExternalOrderSettingsDto,
  IssueExternalOrderDto,
  LinkExternalOrderResultDto,
  PendingExternalOrdersPageDto,
  PendingExternalOrdersQueryDto,
  RecipientSuggestionDto,
  RecipientsQueryDto,
  SendExternalOrderCopyDto,
  VoidExternalOrderDto,
} from './dto/external-order.dto';
import {
  presentCopySent,
  presentExternalOrder,
  presentPending,
} from './external-order.presenter';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

const actorOf = (req: AuthenticatedRequest) => ({
  userId: req.user.sub,
  role: req.user.role,
});

const ORDER = { lookup: 'externalOrder', param: 'id' } as const;
const NOT_FOUND =
  'Orden no encontrada en esta clínica (o de una sede no permitida)';
const PDF_SCHEMA = { type: 'string', format: 'binary' } as const;

/**
 * DX-572: órdenes de estudios y referencias externas de la ficha del
 * paciente. Sin PATCH ni DELETE A PROPÓSITO: una orden emitida es
 * inalterable (la protege un trigger) y solo se ANULA con motivo.
 */
@ApiTags('external-orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXTERNAL_ORDER_ROLES)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/external-orders')
export class PatientExternalOrdersController {
  constructor(private readonly orders: ExternalOrdersUseCases) {}

  @Audit({
    action: 'VIEW',
    resource: 'EXTERNAL_ORDER',
    patient: { param: 'patientId' },
  })
  @Get()
  @ApiOperation({
    summary:
      'Órdenes externas del paciente (más reciente primero, con anuladas)',
    description:
      'De las sedes permitidas al usuario. La nota clínica solo sale para los roles clínicos; recepción recibe `clinicalNote: null` y `hasClinicalNote`.',
  })
  @ApiOkResponse({ type: [ExternalOrderDto] })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  async list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExternalOrderDto[]> {
    const list = await this.orders.listForPatient(patientId, actorOf(req));
    return list.map(presentExternalOrder);
  }

  @Audit({
    action: 'CREATE',
    resource: 'EXTERNAL_ORDER',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
    reason: 'EXTERNAL_ORDER_ISSUED',
  })
  @Post()
  @ApiOperation({
    summary: 'Emitir una orden de estudios o una referencia a especialista',
    description:
      'DENTIST o ADMIN con registro profesional. Desde la ficha (sede activa) o desde una cita del paciente (su sede). Guarda la foto de clínica, sede, profesional y paciente, el número de la sede y el logo de hoy, y archiva el PDF SIN la nota en los documentos del paciente (REFERRAL). Auditado: CREATE · EXTERNAL_ORDER · EXTERNAL_ORDER_ISSUED (sin estudios, destinatario ni nota).',
  })
  @ApiCreatedResponse({ type: ExternalOrderDto })
  @ApiBadRequestResponse({
    description:
      'Contenido inválido o sin registro profesional (mensaje en español que dice qué falta)',
  })
  @ApiForbiddenResponse({
    description:
      'Recepción o auxiliar (solo emiten DENTIST y ADMIN), o la sede no está permitida (LOCATION_NOT_ALLOWED)',
  })
  @ApiNotFoundResponse({
    description:
      'Paciente, cita (de otro paciente o clínica) o plantilla no encontrados',
  })
  @ApiConflictResponse({
    description:
      'Plantilla desactivada, o la sede no tiene zona o formato regional',
  })
  async issue(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: IssueExternalOrderDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExternalOrderDto> {
    const order = await this.orders.issue(
      patientId,
      {
        kind: dto.kind,
        recipient: dto.recipient,
        items: dto.items,
        toothNumbers: dto.toothNumbers,
        clinicalNote: dto.clinicalNote,
        appointmentId: dto.appointmentId,
        templateId: dto.templateId,
      },
      actorOf(req),
    );
    return presentExternalOrder(order);
  }
}

/** DX-572: una orden por id, su PDF, anulación, resultado, copia y ajustes. */
@ApiTags('external-orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXTERNAL_ORDER_ROLES)
@Controller('external-orders')
export class ExternalOrdersController {
  constructor(
    private readonly orders: ExternalOrdersUseCases,
    private readonly settings: ExternalOrderSettingsUseCases,
    private readonly sendCopy: SendExternalOrderCopyUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  // Las rutas fijas, antes de `:id` (Express casa en orden).
  @Audit({ action: 'VIEW', resource: 'EXTERNAL_ORDER' })
  @Get('pending')
  @ApiOperation({
    summary: '«Órdenes sin resultado» de una sede',
    description:
      'Las órdenes ISSUED de la sede (la pedida o la activa), la más antigua primero, paginadas, con `ageDays` (días civiles de la sede desde la emisión) y `overdue` (ageDays > N días de la clínica). `overdueOnly=true` deja solo las vencidas. Recepción las ve sin la nota.',
  })
  @ApiOkResponse({ type: PendingExternalOrdersPageDto })
  @ApiBadRequestResponse({ description: 'Sin sede pedida ni activa' })
  @ApiForbiddenResponse({ description: 'La sede no está permitida' })
  async pending(
    @Query() query: PendingExternalOrdersQueryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PendingExternalOrdersPageDto> {
    return presentPending(
      await this.orders.pending(
        {
          locationId: query.locationId,
          overdueOnly: query.overdueOnly,
          page: query.page,
          pageSize: query.pageSize,
        },
        actorOf(req),
      ),
    );
  }

  @Get('recipients')
  @Roles(...EXTERNAL_ORDER_CONFIG_READ_ROLES)
  @ApiOperation({
    summary: 'Sugerencias de destinatario',
    description:
      'Los habituales de las plantillas activas y los distintos de las órdenes de la clínica de los últimos 12 meses (los más usados primero), que contienen `q`. Como mucho 10.',
  })
  @ApiOkResponse({ type: [RecipientSuggestionDto] })
  recipients(
    @Query() query: RecipientsQueryDto,
  ): Promise<RecipientSuggestionDto[]> {
    return this.orders.recipients(query.q);
  }

  @Get('settings')
  @Roles(...EXTERNAL_ORDER_CONFIG_READ_ROLES)
  @ApiOperation({ summary: 'Ajustes de las órdenes externas de la clínica' })
  @ApiOkResponse({ type: ExternalOrderSettingsDto })
  getSettings(): Promise<ExternalOrderSettings> {
    return this.settings.get();
  }

  @Put('settings')
  @Roles(...EXTERNAL_ORDER_CONFIG_WRITE_ROLES)
  @RolesDeniedMessage(EXTERNAL_ORDER_MESSAGES.settingsForbidden)
  @ApiOperation({
    summary: 'Cambia el plazo para «vencida»; queda en la auditoría',
    description:
      'Días (1–365) sin resultado tras los que una orden sale vencida. Si nada cambia, 200 sin evento (UPDATE · CLINIC_SETTINGS · EXTERNAL_ORDER_SETTINGS).',
  })
  @ApiOkResponse({ type: ExternalOrderSettingsDto })
  @ApiBadRequestResponse({ description: 'Días fuera de 1–365' })
  @ApiForbiddenResponse({
    description: EXTERNAL_ORDER_MESSAGES.settingsForbidden,
  })
  updateSettings(
    @Body() dto: ExternalOrderSettingsDto,
    @Req() req: AuditableRequest,
  ): Promise<ExternalOrderSettings> {
    const ctx = auditRequestContext(req, this.tenantContext);
    if (!ctx) throw new Error('Sin sesión de clínica detrás del RolesGuard');
    return this.settings.update({ overdueDays: dto.overdueDays }, ctx);
  }

  @Audit({
    action: 'VIEW',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: ORDER,
  })
  @Get(':id')
  @ApiOperation({ summary: 'Una orden externa' })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ExternalOrderDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  async get(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExternalOrderDto> {
    return presentExternalOrder(await this.orders.get(id, actorOf(req)));
  }

  @Audit({
    action: 'PRINT',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: ORDER,
  })
  @Get(':id/pdf')
  @ApiOperation({
    summary: 'PDF de la orden (generado ahora desde su foto)',
    description:
      'Sin `withNote`, sin la nota clínica (lo que reimprime recepción). `withNote=true`, con ella: solo los roles clínicos. Una anulada sale con «ANULADA». Auditado: PRINT · EXTERNAL_ORDER.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiProduces('application/pdf')
  @ApiOkResponse({ description: 'El PDF (inline).', schema: PDF_SCHEMA })
  @ApiForbiddenResponse({
    description: 'Recepción pidiendo `withNote=true`',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  async pdf(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ExternalOrderPdfQueryDto,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const result = await this.orders.pdf(
      id,
      query.withNote === true,
      actorOf(req),
    );
    res.set('Content-Type', 'application/pdf');
    res.set(
      'Content-Disposition',
      contentDispositionHeader({
        disposition: 'inline',
        filename: result.fileName,
      }),
    );
    res.set('Cache-Control', 'private, no-store');
    return new StreamableFile(result.pdf);
  }

  @Audit({
    action: 'VOID',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: ORDER,
    reason: 'EXTERNAL_ORDER_VOIDED',
  })
  @Post(':id/void')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Anular una orden con motivo',
    description:
      'ADMIN o quien la emitió, solo si está ISSUED. No se borra: queda anulada, el PDF archivado se anula en la ficha, se archiva el PDF con «ANULADA» y la copia enviada deja de servir. Auditado: VOID · EXTERNAL_ORDER · EXTERNAL_ORDER_VOIDED (sin el motivo).',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ExternalOrderDto })
  @ApiBadRequestResponse({ description: 'Motivo de menos de 5 o más de 500' })
  @ApiForbiddenResponse({
    description: 'No la emitió ni es ADMIN, o la sede no está permitida',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({
    description: 'Ya está anulada, o tiene su resultado ligado',
  })
  async void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidExternalOrderDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExternalOrderDto> {
    return presentExternalOrder(
      await this.orders.void(id, dto.reason, actorOf(req)),
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: ORDER,
    reason: 'EXTERNAL_ORDER_RESULT_LINKED',
  })
  @Post(':id/result')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ligar el resultado (un documento del paciente)',
    description:
      'Los 4 roles. La orden pasa de ISSUED a RESULT_RECEIVED y sale de «Órdenes sin resultado». El documento es del MISMO paciente y no está anulado; puede ser el resultado de varias órdenes. Auditado: UPDATE · EXTERNAL_ORDER · EXTERNAL_ORDER_RESULT_LINKED.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ExternalOrderDto })
  @ApiNotFoundResponse({
    description: 'La orden, o el documento (de otro paciente o clínica)',
  })
  @ApiConflictResponse({
    description:
      'La orden está anulada o ya tiene resultado, o el documento está anulado',
  })
  async linkResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkExternalOrderResultDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExternalOrderDto> {
    return presentExternalOrder(
      await this.orders.linkResult(id, dto.documentId, actorOf(req)),
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: ORDER,
    reason: 'EXTERNAL_ORDER_RESULT_UNLINKED',
  })
  @Post(':id/result/unlink')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Desligar el resultado',
    description:
      'Un rol clínico o quien lo ligó. RESULT_RECEIVED → ISSUED (vuelve a «Órdenes sin resultado»); el documento sigue en la ficha. Auditado: UPDATE · EXTERNAL_ORDER · EXTERNAL_ORDER_RESULT_UNLINKED.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ExternalOrderDto })
  @ApiForbiddenResponse({
    description: 'Recepción que no ligó ese resultado',
  })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: 'La orden no tiene resultado ligado' })
  async unlinkResult(
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExternalOrderDto> {
    return presentExternalOrder(
      await this.orders.unlinkResult(id, actorOf(req)),
    );
  }

  @Audit({
    action: 'SEND',
    resource: 'EXTERNAL_ORDER',
    resourceId: { param: 'id' },
    patient: ORDER,
    reason: EXTERNAL_ORDER_COPY_SENT_REASON,
  })
  @Post(':id/patient-copy')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Enviar al paciente una copia de la orden (email o WhatsApp)',
    description:
      'Los 4 roles; orden ISSUED o RESULT_RECEIVED. Crea un enlace de UN SOLO USO (7 días por defecto; se guarda solo el hash) que se gasta al descargar el PDF; el anterior deja de servir. EMAIL: el outbox envía el enlace (sin adjunto). WHATSAPP: devuelve el número, el enlace y el texto para wa.me. La copia lleva la nota clínica (es del paciente). Un menor la recibe por su responsable que recibe avisos. Auditado: SEND · EXTERNAL_ORDER · EXTERNAL_ORDER_COPY_SENT.',
  })
  @ApiParam({ name: 'id', format: 'uuid' })
  @ApiOkResponse({ type: ExternalOrderCopySentDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiForbiddenResponse({ description: 'La sede no está permitida' })
  @ApiConflictResponse({
    description:
      'La orden está anulada, el paciente está archivado, la sede no tiene zona o formato, o no se pudo armar el enlace de la clínica',
  })
  @ApiUnprocessableEntityResponse({
    description:
      'Sin a quién enviarlo: sin email o teléfono para WhatsApp, baja de los envíos, o un menor sin responsable con ese contacto',
  })
  @ApiTooManyRequestsResponse({
    description: 'Tope de emails de la clínica o del destinatario',
  })
  async sendPatientCopy(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SendExternalOrderCopyDto,
    @Req() req: AuthenticatedRequest & TenantHostRequest,
  ): Promise<ExternalOrderCopySentDto> {
    return presentCopySent(
      await this.sendCopy.execute(
        id,
        dto.channel,
        actorOf(req),
        req.tenantHost?.host,
      ),
    );
  }
}
