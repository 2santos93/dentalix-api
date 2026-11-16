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
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import { COLLECTION_ROLES } from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreateCollectionNoteUseCase,
  CreatePaymentPromiseUseCase,
  GetPatientCollectionsUseCase,
  MarkBalanceReminderUseCase,
  PROMISE_ALREADY_OPEN_MESSAGE,
  REMINDER_ALREADY_TODAY_MESSAGE,
} from '../application/use-cases/collections.use-cases';
import type {
  CollectionNoteView,
  PatientCollections,
  PaymentPromiseView,
} from '../domain/collections.entity';
import {
  CollectionNoteDto,
  CreateCollectionNoteDto,
  CreatePaymentPromiseDto,
  MarkBalanceReminderDto,
  PatientCollectionsDto,
  PaymentPromiseDto,
} from './dto/collections.dto';

export const COLLECTIONS_FORBIDDEN_MESSAGE =
  'Tu rol no gestiona la cobranza: es para administración y recepción.';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description: 'Sede activa: queda en la nota y es la sede del compromiso.',
};

// Cobranza (DX-150): dato FINANCIERO -> COLLECTION_ROLES (ADMIN + RECEPTION),
// 403 en español para el resto. Sin PATCH ni DELETE A PROPÓSITO: notas y
// compromisos son append-only (también en la BD). La auditoría lleva quién y
// qué (nombres de campos), nunca el texto de la nota ni importes.
@ApiTags('collections')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...COLLECTION_ROLES)
@RolesDeniedMessage(COLLECTIONS_FORBIDDEN_MESSAGE)
@Controller('patients/:id')
export class CollectionsController {
  constructor(
    private readonly createNote: CreateCollectionNoteUseCase,
    private readonly createPromise: CreatePaymentPromiseUseCase,
    private readonly getCollections: GetPatientCollectionsUseCase,
    private readonly markReminder: MarkBalanceReminderUseCase,
  ) {}

  // DX-146: «Marcar avisado» de «Por avisar hoy». Escritura de cobranza:
  // COLLECTION_ROLES (ADMIN + RECEPTION), como el resto de gestiones; leer la
  // cartera con un permiso extra (DX-090) no da para escribir en ella.
  @Audit({
    action: 'CREATE',
    resource: 'COLLECTION_NOTE',
    resourceId: { response: 'id' },
    patient: { param: 'id' },
    reason: 'BALANCE_REMINDER',
  })
  @Post('balance-reminders')
  @ApiOperation({
    summary: 'Marcar avisado del saldo vencido (DX-146)',
    description:
      'Crea una gestión de cobranza REMINDER_SENT (append-only; no se desmarca). Un aviso por paciente y día civil de la sede de su deuda: el paciente sale de «Por avisar hoy» hasta su siguiente tramo. Sin cuerpo del mensaje ni importes.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiCreatedResponse({ type: CollectionNoteDto })
  @ApiBadRequestResponse({ description: 'Canal inválido o nota de más de 280' })
  @ApiForbiddenResponse({
    description: `${COLLECTIONS_FORBIDDEN_MESSAGE} O la deuda es de una sede a la que no tienes acceso.`,
  })
  @ApiNotFoundResponse({
    description: 'Paciente de otra clínica o inexistente',
  })
  @ApiConflictResponse({ description: REMINDER_ALREADY_TODAY_MESSAGE })
  balanceReminder(
    @Param('id', ParseUUIDPipe) patientId: string,
    @Body() dto: MarkBalanceReminderDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CollectionNoteView> {
    return this.markReminder.execute(
      patientId,
      { channel: dto.channel ?? 'WHATSAPP_LINK', text: dto.text },
      req.user.sub,
    );
  }

  @Audit({
    action: 'CREATE',
    resource: 'COLLECTION_NOTE',
    resourceId: { response: 'id' },
    patient: { param: 'id' },
  })
  @Post('collection-notes')
  @ApiOperation({
    summary: 'Registrar una gestión de cobro (append-only)',
    description:
      'Canal, resultado y una nota corta (≤ 280, sin datos clínicos). No se edita ni se borra: una corrección es otra nota.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiCreatedResponse({ type: CollectionNoteDto })
  @ApiBadRequestResponse({
    description: 'Canal o resultado inválidos, o nota de más de 280',
  })
  @ApiForbiddenResponse({ description: COLLECTIONS_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({
    description: 'Paciente de otra clínica o inexistente',
  })
  note(
    @Param('id', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateCollectionNoteDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<CollectionNoteView> {
    return this.createNote.execute(
      patientId,
      { channel: dto.channel, outcome: dto.outcome, text: dto.text },
      req.user.sub,
    );
  }

  @Audit({
    action: 'CREATE',
    resource: 'PAYMENT_PROMISE',
    resourceId: { response: 'id' },
    patient: { param: 'id' },
  })
  @Post('payment-promises')
  @ApiOperation({
    summary: 'Registrar un compromiso de pago',
    description:
      'Importe, moneda y día en la zona de la sede. Uno abierto por paciente. Pasa a KEPT al cubrirse con abonos registrados desde el compromiso y fechados hasta su día, y a BROKEN el día siguiente si no.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiCreatedResponse({ type: PaymentPromiseDto })
  @ApiBadRequestResponse({
    description:
      'Importe, moneda, fecha (pasada o a más de un año) o sede inválidos',
  })
  @ApiForbiddenResponse({ description: COLLECTIONS_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({
    description: 'Paciente de otra clínica o inexistente',
  })
  @ApiConflictResponse({ description: PROMISE_ALREADY_OPEN_MESSAGE })
  promise(
    @Param('id', ParseUUIDPipe) patientId: string,
    @Body() dto: CreatePaymentPromiseDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<PaymentPromiseView> {
    return this.createPromise.execute(
      patientId,
      {
        amount: dto.amount,
        currency: dto.currency,
        dueDate: dto.dueDate,
        locationId: dto.locationId,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'PAYMENT_PROMISE',
    patient: { param: 'id' },
    reason: 'PATIENT_COLLECTIONS',
  })
  @Get('collections')
  @ApiOperation({
    summary: 'Cobranza del paciente: gestiones y compromisos',
    description: 'Más recientes primero, con lo cubierto de cada compromiso.',
  })
  @ApiOkResponse({ type: PatientCollectionsDto })
  @ApiForbiddenResponse({ description: COLLECTIONS_FORBIDDEN_MESSAGE })
  @ApiNotFoundResponse({
    description: 'Paciente de otra clínica o inexistente',
  })
  list(
    @Param('id', ParseUUIDPipe) patientId: string,
  ): Promise<PatientCollections> {
    return this.getCollections.execute(patientId);
  }
}
