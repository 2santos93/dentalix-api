import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
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
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import {
  Roles,
  RolesDeniedMessage,
} from '../../auth/presentation/guards/roles.decorator';
import {
  ORTHO_ACCOUNT_READ_ROLES,
  ORTHO_FOLLOW_UP_ROLES,
  ORTHO_READ_ROLES,
  ORTHO_SETTINGS_READ_ROLES,
  ORTHO_SETTINGS_WRITE_ROLES,
  ORTHO_WRITE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  auditRequestContext,
  requireAuditRequestContext,
  type AuditableRequest,
} from '../../audit/presentation/audit-request-context';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import {
  OrthoCaseUseCases,
  OrthoFollowUpUseCase,
  OrthoSettingsUseCases,
  OrthoVisitUseCases,
} from '../application/use-cases/ortho.use-cases';
import {
  OrthoAlignerUseCases,
  OrthoBillingUseCases,
} from '../application/use-cases/ortho-billing.use-cases';
import { DrainAllocationRebalancesInterceptor } from '../../payments/presentation/drain-allocation-rebalances.interceptor';
import type {
  OrthoAlignersView,
  OrthoCaseAccount,
  OrthoCaseView,
  OrthoFollowUpPage,
  OrthoSettings,
  OrthoVisitView,
} from '../domain/entities';
import {
  AddOrthoAlignerDeliveryDto,
  ChangeOrthoCaseStatusDto,
  CreateOrthoAlignerSeriesDto,
  OrthoAlignersDto,
  OrthoCaseAccountDto,
  SetOrthoFeeDto,
  CreateOrthoCaseDto,
  OrthoCaseDto,
  OrthoFollowUpPageDto,
  OrthoFollowUpQueryDto,
  OrthoSettingsDto,
  OrthoVisitDto,
  RegisterOrthoVisitDto,
  UpdateOrthoCaseDto,
  UpdateOrthoSettingsDto,
} from './dto/ortho.dto';

interface AuthenticatedRequest extends AuditableRequest {
  user: TenantJwtPayload;
}

export const ORTHO_WRITE_FORBIDDEN_MESSAGE =
  'Solo el odontólogo o la administración abren casos de ortodoncia y registran sus controles.';
export const ORTHO_READ_FORBIDDEN_MESSAGE =
  'El caso de ortodoncia es historia clínica: tu rol no lo consulta. La lista de seguimiento sí está en Pacientes › Ortodoncia.';
export const ORTHO_FEE_FORBIDDEN_MESSAGE =
  'Solo el odontólogo o la administración ponen y aceptan el honorario del caso. Recepción ve la cuenta del caso.';
export const ORTHO_ALIGNER_FORBIDDEN_MESSAGE =
  'Solo el odontólogo o la administración registran los alineadores y sus entregas.';
export const ORTHO_SETTINGS_FORBIDDEN_MESSAGE =
  'Solo un administrador puede cambiar los ajustes de ortodoncia.';

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description: 'Sede activa. Sin ella, la sede principal (o las permitidas).',
};

/**
 * Caso de ortodoncia del paciente (DX-190). Sin DELETE A PROPÓSITO: es
 * historia clínica (la BD tampoco lo deja). Un control no se edita ni se
 * borra: se corrige con una adenda de su evolución
 * (POST /patients/:patientId/clinical-entries/:entryId/addenda).
 */
@ApiTags('orthodontics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// DX-285: los cargos del plan (control realizado, honorario aceptado, retiro)
// se reparten entre los abonos al terminar la escritura (DX-051).
@UseInterceptors(TenantContextInterceptor, DrainAllocationRebalancesInterceptor)
@Roles(...ORTHO_READ_ROLES)
@RolesDeniedMessage(ORTHO_READ_FORBIDDEN_MESSAGE)
@ApiParam({ name: 'patientId', format: 'uuid' })
@Controller('patients/:patientId/ortho-cases')
export class PatientOrthoController {
  constructor(
    private readonly cases: OrthoCaseUseCases,
    private readonly visits: OrthoVisitUseCases,
    private readonly billing: OrthoBillingUseCases,
    private readonly aligners: OrthoAlignerUseCases,
    private readonly tenantContext: TenantContextService,
  ) {}

  // -- DX-285: cuenta del caso (los cuatro roles; sin datos clínicos)

  @Audit({
    action: 'VIEW',
    resource: 'ORTHO_CASE',
    patient: { param: 'patientId' },
    reason: 'ORTHO_CASE_ACCOUNTS',
  })
  @Get('accounts')
  @Roles(...ORTHO_ACCOUNT_READ_ROLES)
  @ApiOperation({
    summary: 'Cuentas de los casos con honorario del paciente',
    description:
      'Para recepción, que no consulta el caso clínico: honorario, realizado, pagado, saldo y saldo vencido de cada caso con honorario, el más reciente primero.',
  })
  @ApiOkResponse({ type: [OrthoCaseAccountDto] })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  accounts(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<OrthoCaseAccount[]> {
    return this.billing.accounts(patientId);
  }

  @Audit({
    action: 'VIEW',
    resource: 'ORTHO_CASE',
    resourceId: { param: 'caseId' },
    patient: { param: 'patientId' },
    reason: 'ORTHO_CASE_ACCOUNT',
  })
  @Get(':caseId/account')
  @Roles(...ORTHO_ACCOUNT_READ_ROLES)
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({
    summary: 'Cuenta del caso: honorario, realizado, pagado y saldo vencido',
    description:
      'Realizado = cargos hechos (inicial al aceptar, control n.º k al registrarlo, retiro al pasar a retención o finalizar). Pagado = lo imputado a esos cargos (DX-051). Vencido = lo realizado y sin pagar de hace más de `overdueDays` días (ajuste de la clínica) en el día civil de la sede. Con cuotas en el plan (`billing` PAYMENT_PLAN) solo se informan.',
  })
  @ApiOkResponse({ type: OrthoCaseAccountDto })
  @ApiNotFoundResponse({ description: 'Paciente o caso de otra clínica' })
  account(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ): Promise<OrthoCaseAccount> {
    return this.billing.account(patientId, caseId);
  }

  // Auditado en el caso de uso (UPDATE ORTHO_CASE ORTHO_FEE_UPDATED con los
  // nombres de lo que cambió; nunca importes).
  @Put(':caseId/fee')
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_FEE_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({
    summary: 'Pone o cambia el honorario del caso y su reparto',
    description:
      'total = inicial + importe por control × controles + retiro, al céntimo (si no, 400). Moneda: la del plan ligado o la de la sede del caso. Ya aceptado, 409.',
  })
  @ApiOkResponse({ type: OrthoCaseAccountDto })
  @ApiBadRequestResponse({
    description: 'El reparto no cuadra con el total o importes inválidos',
  })
  @ApiNotFoundResponse({ description: 'Paciente o caso de otra clínica' })
  @ApiConflictResponse({
    description: 'Caso cerrado, honorario ya aceptado o sede sin moneda',
  })
  @ApiForbiddenResponse({ description: ORTHO_FEE_FORBIDDEN_MESSAGE })
  setFee(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: SetOrthoFeeDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoCaseAccount> {
    return this.billing.setFee(
      patientId,
      caseId,
      {
        total: dto.total,
        initial: dto.initial,
        perVisit: dto.perVisit,
        visitCount: dto.visitCount,
        retention: dto.retention,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Auditado en el caso de uso (UPDATE ORTHO_CASE ORTHO_FEE_ACCEPTED).
  @Post(':caseId/fee/accept')
  @HttpCode(200)
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_FEE_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({
    summary: 'Acepta el honorario: crea sus cargos en el plan ligado',
    description:
      'En el plan ligado (ACEPTADO y sin firma) o, sin plan, en uno nuevo «Ortodoncia» que se liga al caso: la cuota inicial (ya realizada), un ítem por control («Ortodoncia: control 3 de 24») y el retiro. Los controles ya registrados realizan sus cargos. Si el plan ligado ya tiene cuotas activas, no se crea ningún cargo (no se duplica): la cuenta las informa.',
  })
  @ApiOkResponse({ type: OrthoCaseAccountDto })
  @ApiNotFoundResponse({ description: 'Paciente o caso de otra clínica' })
  @ApiConflictResponse({
    description:
      'Sin honorario, ya aceptado, caso cerrado, o el plan ligado sin aceptar, firmado, cerrado o en otra moneda',
  })
  @ApiForbiddenResponse({ description: ORTHO_FEE_FORBIDDEN_MESSAGE })
  acceptFee(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoCaseAccount> {
    return this.billing.acceptFee(
      patientId,
      caseId,
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // -- DX-285: alineadores (historia clínica: lectura como el caso)

  @Audit({
    action: 'VIEW',
    resource: 'ORTHO_CASE',
    resourceId: { param: 'caseId' },
    patient: { param: 'patientId' },
    reason: 'ORTHO_ALIGNERS',
  })
  @Get(':caseId/aligners')
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({
    summary: 'Series de alineadores del caso con la bandeja actual por arcada',
  })
  @ApiOkResponse({ type: OrthoAlignersDto })
  @ApiNotFoundResponse({ description: 'Paciente o caso de otra clínica' })
  listAligners(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ): Promise<OrthoAlignersView> {
    return this.aligners.list(patientId, caseId);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'ORTHO_CASE',
    resourceId: { param: 'caseId' },
    patient: { param: 'patientId' },
    reason: 'ORTHO_ALIGNER_SERIES',
  })
  @Post(':caseId/aligner-series')
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_ALIGNER_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({
    summary: 'Abre una serie de alineadores (o un refinamiento)',
    description:
      'Por arcada (superior, inferior o ambas): marca, n.º de bandejas y días por bandeja. Un refinamiento (`refinementOfId`) abre una serie nueva y la anterior se conserva.',
  })
  @ApiCreatedResponse({ type: OrthoAlignersDto })
  @ApiBadRequestResponse({
    description: 'Arcada, marca o bandejas fuera de rango; serie de otro caso',
  })
  @ApiNotFoundResponse({ description: 'Paciente o caso de otra clínica' })
  @ApiConflictResponse({ description: 'Caso cerrado o módulo apagado' })
  @ApiForbiddenResponse({ description: ORTHO_ALIGNER_FORBIDDEN_MESSAGE })
  createAlignerSeries(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: CreateOrthoAlignerSeriesDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoAlignersView> {
    return this.aligners.createSeries(
      patientId,
      caseId,
      {
        arch: dto.arch,
        brand: dto.brand,
        totalTrays: dto.totalTrays,
        daysPerTray: dto.daysPerTray,
        refinementOfId: dto.refinementOfId,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'ORTHO_CASE',
    resourceId: { param: 'caseId' },
    patient: { param: 'patientId' },
    reason: 'ORTHO_ALIGNER_DELIVERY',
  })
  @Post(':caseId/aligner-series/:seriesId/deliveries')
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_ALIGNER_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiParam({ name: 'seriesId', format: 'uuid' })
  @ApiOperation({
    summary: 'Registra una entrega de bandejas (de la X a la Y)',
    description:
      'Seguida de la última entregada, dentro de la serie, con fecha no futura (sin fecha: el día del control `visitId` o hoy en la sede).',
  })
  @ApiCreatedResponse({ type: OrthoAlignersDto })
  @ApiBadRequestResponse({
    description:
      'Bandejas no seguidas o más allá de la serie, fecha inválida o control de otro caso',
  })
  @ApiNotFoundResponse({
    description: 'Paciente, caso o serie de otra clínica',
  })
  @ApiConflictResponse({ description: 'Caso cerrado o módulo apagado' })
  @ApiForbiddenResponse({ description: ORTHO_ALIGNER_FORBIDDEN_MESSAGE })
  addAlignerDelivery(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Param('seriesId', ParseUUIDPipe) seriesId: string,
    @Body() dto: AddOrthoAlignerDeliveryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoAlignersView> {
    return this.aligners.addDelivery(
      patientId,
      caseId,
      seriesId,
      {
        fromTray: dto.fromTray,
        toTray: dto.toTray,
        deliveredOn: dto.deliveredOn,
        visitId: dto.visitId,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'ORTHO_CASE',
    patient: { param: 'patientId' },
  })
  @Get()
  @ApiOperation({
    summary: 'Casos de ortodoncia del paciente con progreso y arco actual',
  })
  @ApiOkResponse({ type: [OrthoCaseDto] })
  @ApiNotFoundResponse({
    description: 'Paciente no encontrado en esta clínica',
  })
  @ApiForbiddenResponse({ description: ORTHO_READ_FORBIDDEN_MESSAGE })
  list(
    @Param('patientId', ParseUUIDPipe) patientId: string,
  ): Promise<OrthoCaseView[]> {
    return this.cases.list(patientId);
  }

  @Audit({
    action: 'CREATE',
    resource: 'ORTHO_CASE',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post()
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_WRITE_FORBIDDEN_MESSAGE)
  @ApiHeader(LOCATION_HEADER)
  @ApiOperation({
    summary: 'Abre un caso de ortodoncia (uno activo por paciente)',
  })
  @ApiCreatedResponse({ type: OrthoCaseDto })
  @ApiBadRequestResponse({
    description:
      'Técnica, fechas, meses, controles o intervalo fuera de rango; responsable que no atiende; plan de otro paciente',
  })
  @ApiNotFoundResponse({
    description: 'Paciente, sede o profesional no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'El paciente ya tiene un caso activo, o la clínica no tiene la ortodoncia activada',
  })
  @ApiForbiddenResponse({ description: ORTHO_WRITE_FORBIDDEN_MESSAGE })
  create(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Body() dto: CreateOrthoCaseDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoCaseView> {
    return this.cases.create(
      patientId,
      {
        technique: dto.technique,
        startDate: dto.startDate,
        estimatedMonths: dto.estimatedMonths,
        plannedVisits: dto.plannedVisits,
        visitIntervalDays: dto.visitIntervalDays,
        bondedOn: dto.bondedOn,
        debondedOn: dto.debondedOn,
        providerId: dto.providerId,
        locationId: dto.locationId,
        treatmentPlanId: dto.treatmentPlanId,
      },
      req.user.sub,
    );
  }

  @Audit({
    action: 'UPDATE',
    resource: 'ORTHO_CASE',
    resourceId: { param: 'caseId' },
    patient: { param: 'patientId' },
    reason: 'ORTHO_CASE_UPDATED',
  })
  @Patch(':caseId')
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_WRITE_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({ summary: 'Cambia la planificación del caso (abierto)' })
  @ApiOkResponse({ type: OrthoCaseDto })
  @ApiBadRequestResponse({ description: 'Valores fuera de rango' })
  @ApiNotFoundResponse({ description: 'Paciente o caso de otra clínica' })
  @ApiConflictResponse({ description: 'El caso está cerrado' })
  @ApiForbiddenResponse({ description: ORTHO_WRITE_FORBIDDEN_MESSAGE })
  update(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: UpdateOrthoCaseDto,
  ): Promise<OrthoCaseView> {
    return this.cases.update(patientId, caseId, {
      technique: dto.technique,
      startDate: dto.startDate,
      estimatedMonths: dto.estimatedMonths,
      plannedVisits: dto.plannedVisits,
      visitIntervalDays: dto.visitIntervalDays,
      bondedOn: dto.bondedOn,
      debondedOn: dto.debondedOn,
      providerId: dto.providerId,
      treatmentPlanId: dto.treatmentPlanId,
    });
  }

  // Auditado en el caso de uso (UPDATE ORTHO_CASE con el estado antes y
  // después; nunca el motivo escrito).
  @Post(':caseId/status')
  @HttpCode(200)
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_WRITE_FORBIDDEN_MESSAGE)
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({
    summary: 'Pasa el caso a retención, lo finaliza o lo da por abandonado',
    description:
      'ACTIVE → RETENTION | FINISHED | ABANDONED; RETENTION → FINISHED | ABANDONED. El abandono exige motivo. Un caso cerrado ya no cambia.',
  })
  @ApiOkResponse({ type: OrthoCaseDto })
  @ApiBadRequestResponse({
    description: 'Transición no permitida o sin motivo',
  })
  @ApiNotFoundResponse({ description: 'Paciente o caso de otra clínica' })
  @ApiConflictResponse({
    description: 'El caso está cerrado o cambió a la vez',
  })
  @ApiForbiddenResponse({ description: ORTHO_WRITE_FORBIDDEN_MESSAGE })
  changeStatus(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: ChangeOrthoCaseStatusDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoCaseView> {
    return this.cases.changeStatus(
      patientId,
      caseId,
      { status: dto.status, reason: dto.reason },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  @Audit({
    action: 'VIEW',
    resource: 'ORTHO_VISIT',
    patient: { param: 'patientId' },
  })
  @Get(':caseId/visits')
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({
    summary: 'Controles del caso con sus adendas, el más reciente primero',
  })
  @ApiOkResponse({ type: [OrthoVisitDto] })
  @ApiNotFoundResponse({ description: 'Paciente o caso de otra clínica' })
  listVisits(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
  ): Promise<OrthoVisitView[]> {
    return this.visits.list(patientId, caseId);
  }

  @Audit({
    action: 'CREATE',
    resource: 'ORTHO_VISIT',
    resourceId: { response: 'id' },
    patient: { param: 'patientId' },
  })
  @Post(':caseId/visits')
  @Roles(...ORTHO_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_WRITE_FORBIDDEN_MESSAGE)
  @ApiHeader(LOCATION_HEADER)
  @ApiParam({ name: 'caseId', format: 'uuid' })
  @ApiOperation({
    summary: 'Registra un control (inalterable: se corrige con una adenda)',
    description:
      'Crea la evolución que lo documenta (mismas reglas que una evolución: cita de este paciente, atendida y no futura; fecha no futura) y el control estructurado en la misma transacción. Los calibres salen de la lista de la clínica.',
  })
  @ApiCreatedResponse({ type: OrthoVisitDto })
  @ApiBadRequestResponse({
    description:
      'Control vacío, calibre fuera de la lista, higiene fuera de 1–4, próximo control no posterior, cita de otro paciente o no atendida',
  })
  @ApiNotFoundResponse({
    description: 'Paciente, caso o cita no encontrados en esta clínica',
  })
  @ApiConflictResponse({
    description:
      'El caso no está activo ni en retención, o la clínica no tiene la ortodoncia activada',
  })
  @ApiForbiddenResponse({ description: ORTHO_WRITE_FORBIDDEN_MESSAGE })
  registerVisit(
    @Param('patientId', ParseUUIDPipe) patientId: string,
    @Param('caseId', ParseUUIDPipe) caseId: string,
    @Body() dto: RegisterOrthoVisitDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoVisitView> {
    return this.visits.register(
      patientId,
      caseId,
      {
        entryDate: dto.entryDate,
        appointmentId: dto.appointmentId,
        upperWire: dto.upperWire,
        lowerWire: dto.lowerWire,
        elasticsType: dto.elasticsType,
        elasticsWear: dto.elasticsWear,
        applianceChanges: dto.applianceChanges,
        incidents: dto.incidents,
        hygieneIndex: dto.hygieneIndex,
        note: dto.note,
        nextVisitProposedOn: dto.nextVisitProposedOn,
      },
      req.user.sub,
      auditRequestContext(req, this.tenantContext),
    );
  }
}

/** Ajustes y lista de seguimiento de la clínica (DX-190). */
@ApiTags('orthodontics')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...ORTHO_FOLLOW_UP_ROLES)
@Controller('ortho')
export class OrthoController {
  constructor(
    private readonly settings: OrthoSettingsUseCases,
    private readonly followUp: OrthoFollowUpUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Get('settings')
  @Roles(...ORTHO_SETTINGS_READ_ROLES)
  @ApiOperation({
    summary:
      'Ajustes de ortodoncia: módulo activo, calibres de arco y umbral del saldo vencido',
  })
  @ApiOkResponse({ type: OrthoSettingsDto })
  getSettings(): Promise<OrthoSettings> {
    return this.settings.get();
  }

  @Put('settings')
  @Roles(...ORTHO_SETTINGS_WRITE_ROLES)
  @RolesDeniedMessage(ORTHO_SETTINGS_FORBIDDEN_MESSAGE)
  @ApiOperation({
    summary:
      'Activa la ortodoncia o cambia los calibres (solo ADMIN, auditado)',
    description:
      'Un control guardado conserva el calibre que se eligió aunque la lista cambie. Si nada cambia, 200 sin evento de auditoría.',
  })
  @ApiOkResponse({ type: OrthoSettingsDto })
  @ApiBadRequestResponse({
    description:
      'Lista vacía, más de 40, calibres repetidos o de más de 20 caracteres',
  })
  @ApiForbiddenResponse({ description: ORTHO_SETTINGS_FORBIDDEN_MESSAGE })
  updateSettings(
    @Body() dto: UpdateOrthoSettingsDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<OrthoSettings> {
    return this.settings.update(
      {
        enabled: dto.enabled,
        wireGauges: dto.wireGauges,
        overdueDays: dto.overdueDays,
      },
      requireAuditRequestContext(req, this.tenantContext),
    );
  }

  // Lista de muchos pacientes con teléfonos: el evento no lleva paciente,
  // pero queda quién la consultó (mismo criterio que la lista de recall).
  @Audit({ action: 'VIEW', resource: 'ORTHO_CASE', reason: 'ORTHO_FOLLOW_UP' })
  @Get('follow-up')
  @ApiHeader(LOCATION_HEADER)
  @ApiOperation({
    summary: 'Casos activos: atrasados, sin próxima cita y no-show',
    description:
      '«Atrasado»: el último control (o, sin controles, el inicio) fue hace más de intervalo + 15 días, en el día civil de la sede del caso. «Sin próxima cita»: sin cita futura agendada o confirmada ni una en curso. Filtrable por sede y profesional; respeta las sedes del miembro.',
  })
  @ApiOkResponse({ type: OrthoFollowUpPageDto })
  @ApiBadRequestResponse({ description: 'Filtro, página o ids inválidos' })
  @ApiForbiddenResponse({
    description: '403 LOCATION_NOT_ALLOWED: sede no permitida al miembro',
  })
  list(@Query() query: OrthoFollowUpQueryDto): Promise<OrthoFollowUpPage> {
    return this.followUp.execute({
      filter: query.filter,
      locationId: query.locationId,
      providerId: query.providerId,
      page: query.page,
      pageSize: query.pageSize,
    });
  }
}
