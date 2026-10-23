import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
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
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
  ApiUnprocessableEntityResponse,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/presentation/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/presentation/guards/roles.guard';
import { Roles } from '../../auth/presentation/guards/roles.decorator';
import {
  EXPENSE_CAPTURE_ROLES,
  EXPENSE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { RateLimit } from '../../../shared/security/rate-limit.decorator';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { Audit } from '../../audit/presentation/audit.decorator';
import { auditRequestContext } from '../../audit/presentation/audit-request-context';
import { AddExpensePaymentUseCase } from '../application/use-cases/add-expense-payment.use-case';
import { AttachExpenseReceiptUseCase } from '../application/use-cases/attach-expense-receipt.use-case';
import { CreateExpenseUploadUseCase } from '../application/use-cases/create-expense-upload.use-case';
import { CreateExpenseUseCase } from '../application/use-cases/create-expense.use-case';
import { GetExpenseReceiptUrlUseCase } from '../application/use-cases/get-expense-receipt-url.use-case';
import { GetExpenseUseCase } from '../application/use-cases/get-expense.use-case';
import { ListExpensesUseCase } from '../application/use-cases/list-expenses.use-case';
import { SuggestSuppliersUseCase } from '../application/use-cases/suggest-suppliers.use-case';
import { UpdateExpenseUseCase } from '../application/use-cases/update-expense.use-case';
import { VoidExpensePaymentUseCase } from '../application/use-cases/void-expense-payment.use-case';
import { VoidExpenseUseCase } from '../application/use-cases/void-expense.use-case';
import type { ExpenseDetailView } from '../application/expense-view';
import type { IdempotencySignals } from '../application/idempotency-guard';
import {
  AddExpensePaymentDto,
  AttachExpenseReceiptDto,
  CreateExpenseDto,
  CreateExpenseUploadDto,
  ListExpensesQueryDto,
  ReceiptUrlQueryDto,
  SuppliersQueryDto,
  UpdateExpenseDto,
  VoidExpenseDto,
} from './dto/expense-requests.dto';
import {
  ExpenseDetailDto,
  ExpensePageDto,
  ExpenseReceiptUploadDto,
  ExpenseReceiptUrlDto,
} from './dto/expense.dto';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
  /** La repetición de una petición idempotente no escribe: no se audita. */
  skipAudit?: boolean;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
}

const LOCATION_HEADER = {
  name: 'X-Location-Id',
  required: false,
  description: 'Sede activa. Sin ella, todas las sedes que el usuario ve.',
};
const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: false,
  description:
    'UUID. Repetir la MISMA petición con la misma clave devuelve el resultado original; con otro cuerpo, 422.',
};
const NOT_FOUND = 'Gasto no encontrado en esta clínica';
const E = { param: 'id' } as const;

// Gastos de la sede (DX-274). La gestión es de ADMIN; recepción solo captura
// (autorización de subida del soporte y sugerencias de proveedor). Ninguna
// ruta borra: anular conserva el gasto y sus pagos. Las rutas fijas
// (`suppliers`, `attachments/upload-url`) van ANTES de `:id`.
@ApiTags('expenses')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXPENSE_ROLES)
@Controller('expenses')
export class ExpensesController {
  constructor(
    private readonly listExpenses: ListExpensesUseCase,
    private readonly getExpense: GetExpenseUseCase,
    private readonly createExpense: CreateExpenseUseCase,
    private readonly updateExpense: UpdateExpenseUseCase,
    private readonly voidExpense: VoidExpenseUseCase,
    private readonly addPayment: AddExpensePaymentUseCase,
    private readonly voidPayment: VoidExpensePaymentUseCase,
    private readonly createUpload: CreateExpenseUploadUseCase,
    private readonly attachReceipt: AttachExpenseReceiptUseCase,
    private readonly receiptUrl: GetExpenseReceiptUrlUseCase,
    private readonly suggestSuppliers: SuggestSuppliersUseCase,
    private readonly tenantContext: TenantContextService,
  ) {}

  @Post('attachments/upload-url')
  @Roles(...EXPENSE_CAPTURE_ROLES)
  // Cada autorización firma una subida de hasta 20 MB al bucket (DX-259).
  @RateLimit('direct-upload')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'Autorización para subir el soporte de un gasto al almacén',
    description:
      'POST prefirmado de pocos minutos para UN fichero (PDF, JPG o PNG de 1 B a 20 MB) con el SHA-256 declarado. El navegador envía `target.fields` y el fichero (campo `file`, al final) a `target.url` y después entrega el `uploadId` al alta del gasto (`attachmentUploadId`) o a `POST /expenses/:id/attachment`. Nada se audita ni se asocia a un gasto hasta entonces.',
  })
  @ApiOkResponse({ type: ExpenseReceiptUploadDto })
  @ApiBadRequestResponse({
    description: 'Tamaño, huella o tipo declarado no válidos, o archivo vacío',
  })
  @ApiPayloadTooLargeResponse({ description: 'Más de 20 MB' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN y recepción' })
  uploadUrl(
    @Body() dto: CreateExpenseUploadDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExpenseReceiptUploadDto> {
    return this.createUpload.execute(dto, req.user.sub);
  }

  @Get('suppliers')
  @Roles(...EXPENSE_CAPTURE_ROLES)
  @ApiOperation({
    summary: 'Proveedores ya usados en gastos (sugerencias)',
    description:
      'Hasta 20 nombres distintos (sin mayúsculas ni tildes) que contienen `query`, el de uso más reciente primero.',
  })
  @ApiOkResponse({ type: [String] })
  @ApiForbiddenResponse({ description: 'Solo ADMIN y recepción' })
  suppliers(@Query() query: SuppliersQueryDto): Promise<string[]> {
    return this.suggestSuppliers.execute(query.query);
  }

  @Audit({ action: 'VIEW', resource: 'EXPENSE' })
  @Get()
  @ApiOperation({
    summary: 'Gastos de las sedes del usuario, paginados',
    description:
      'Filtros: fecha de factura `from`/`to`, `locationId`, `category`, `status` (`OPEN` = pendiente + parcial), `overdue`, `query` (proveedor o descripción). Respeta las sedes permitidas del usuario.',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiOkResponse({ type: ExpensePageDto })
  @ApiBadRequestResponse({ description: 'Fechas o filtros no válidos' })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  list(
    @Query() query: ListExpensesQueryDto,
  ): ReturnType<ListExpensesUseCase['execute']> {
    return this.listExpenses.execute(query);
  }

  @Audit({
    action: 'CREATE',
    resource: 'EXPENSE',
    resourceId: { response: 'id' },
  })
  @Post()
  @ApiOperation({
    summary: 'Registrar un gasto (con su pago y su soporte, opcionalmente)',
  })
  @ApiHeader(LOCATION_HEADER)
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiCreatedResponse({ type: ExpenseDetailDto })
  @ApiBadRequestResponse({
    description:
      'Importe, categoría, fechas, sede, pago o soporte no válidos (mensaje en español)',
  })
  @ApiConflictResponse({
    description:
      'Efectivo fuera de caja en una clínica que lo exige en caja; pago «desde la caja» sin caja abierta en la sede; o la Idempotency-Key ya se usó para un gasto de otra sede',
  })
  @ApiUnprocessableEntityResponse({
    description: 'La Idempotency-Key ya se usó con otros datos',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN, o sede no permitida' })
  async create(
    @Body() dto: CreateExpenseDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExpenseDetailView> {
    const signals: IdempotencySignals = {};
    const created = await this.createExpense.execute(
      dto,
      req.user.sub,
      idempotencyKey,
      signals,
    );
    if (signals.replayed) req.skipAudit = true;
    return created;
  }

  @Audit({ action: 'VIEW', resource: 'EXPENSE', resourceId: E })
  @Get(':id')
  @ApiOperation({ summary: 'Un gasto con sus pagos' })
  @ApiOkResponse({ type: ExpenseDetailDto })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<ExpenseDetailView> {
    return this.getExpense.execute(id);
  }

  @Audit({ action: 'UPDATE', resource: 'EXPENSE', resourceId: E })
  @Patch(':id')
  @ApiOperation({
    summary: 'Editar un gasto no anulado',
    description:
      'Categoría, proveedor, descripción y fechas, siempre. El importe puede cambiar pero nunca por debajo de lo ya pagado; la sede y la moneda solo mientras el gasto no tenga ningún pago.',
  })
  @ApiOkResponse({ type: ExpenseDetailDto })
  @ApiBadRequestResponse({ description: 'Campo no válido' })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({
    description: 'Gasto anulado, con pagos (sede y moneda) o importe < pagado',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateExpenseDto,
  ): Promise<ExpenseDetailView> {
    return this.updateExpense.execute(id, dto);
  }

  @Audit({
    action: 'VOID',
    resource: 'EXPENSE',
    resourceId: E,
    reason: 'EXPENSE_VOIDED',
  })
  @Post(':id/void')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Anular el gasto y todos sus pagos vivos',
    description: 'Anular no borra: el gasto sigue en la lista, tachado.',
  })
  @ApiOkResponse({ type: ExpenseDetailDto })
  @ApiBadRequestResponse({ description: 'Motivo de 5 a 500 caracteres' })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({ description: 'El gasto ya está anulado.' })
  void(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidExpenseDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExpenseDetailView> {
    return this.voidExpense.execute(id, dto.reason, req.user.sub);
  }

  @Audit({
    action: 'CREATE',
    resource: 'EXPENSE',
    resourceId: E,
    reason: 'PAYMENT_ADDED',
  })
  @Post(':id/payments')
  @ApiOperation({
    summary: 'Registrar un pago (total o parcial) del gasto',
    description:
      'La suma de los pagos vivos no puede pasar del importe (400 con lo pendiente). El día del pago no es futuro en la sede.',
  })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiCreatedResponse({ type: ExpenseDetailDto })
  @ApiBadRequestResponse({ description: 'Importe, día o tope no válidos' })
  @ApiNotFoundResponse({ description: NOT_FOUND })
  @ApiConflictResponse({
    description:
      'Gasto anulado; efectivo fuera de caja en una clínica que lo exige en caja; pago «desde la caja» sin caja abierta en la sede; o la Idempotency-Key ya se usó para un pago de otra sede',
  })
  @ApiUnprocessableEntityResponse({
    description: 'La Idempotency-Key ya se usó con otros datos',
  })
  async pay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AddExpensePaymentDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExpenseDetailView> {
    const signals: IdempotencySignals = {};
    const paid = await this.addPayment.execute(
      id,
      dto,
      req.user.sub,
      idempotencyKey,
      signals,
    );
    if (signals.replayed) req.skipAudit = true;
    return paid;
  }

  @Audit({
    action: 'VOID',
    resource: 'EXPENSE',
    resourceId: E,
    reason: 'PAYMENT_VOIDED',
  })
  @Post(':id/payments/:paymentId/void')
  @HttpCode(200)
  @ApiOperation({ summary: 'Anular un pago del gasto (una vez)' })
  @ApiOkResponse({ type: ExpenseDetailDto })
  @ApiBadRequestResponse({ description: 'Motivo de 5 a 500 caracteres' })
  @ApiNotFoundResponse({ description: 'Gasto o pago no encontrado' })
  @ApiConflictResponse({ description: 'El pago ya está anulado.' })
  voidOnePayment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @Body() dto: VoidExpenseDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExpenseDetailView> {
    return this.voidPayment.execute(id, paymentId, dto.reason, req.user.sub);
  }

  @Audit({
    action: 'UPDATE',
    resource: 'EXPENSE',
    resourceId: E,
    reason: 'EXPENSE_RECEIPT_ATTACHED',
  })
  @Post(':id/attachment')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Adjuntar el soporte (una vez) a un gasto que no lo tiene',
    description:
      'Comprueba el objeto subido con `upload-url` (de este usuario): tamaño, SHA-256 y tipo por contenido (PDF, JPG o PNG). Si no vale, el objeto se borra y la respuesta es 400.',
  })
  @ApiOkResponse({ type: ExpenseDetailDto })
  @ApiBadRequestResponse({ description: 'Contenido que no es PDF, JPG o PNG' })
  @ApiNotFoundResponse({ description: 'Gasto o subida no encontrados' })
  @ApiConflictResponse({
    description: 'El gasto ya tiene un soporte o está anulado',
  })
  attachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AttachExpenseReceiptDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExpenseDetailView> {
    return this.attachReceipt.execute(id, dto.uploadId, req.user.sub);
  }

  // Auditada en el caso de uso: VIEW si se abre en el navegador, EXPORT si se
  // descarga (el decorador no puede elegir la acción por la query).
  @Get(':id/attachment/url')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({
    summary: 'URL firmada (5 min) para ver o descargar el soporte',
  })
  @ApiOkResponse({ type: ExpenseReceiptUrlDto })
  @ApiNotFoundResponse({ description: 'Gasto no encontrado o sin soporte' })
  attachmentUrl(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ReceiptUrlQueryDto,
    @Req() req: AuthenticatedRequest,
  ): ReturnType<GetExpenseReceiptUrlUseCase['execute']> {
    return this.receiptUrl.execute(
      id,
      query.disposition ?? 'inline',
      auditRequestContext(req, this.tenantContext),
    );
  }
}
