import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
  EXPENSE_CAPTURE_ROLES,
  EXPENSE_ROLES,
} from '../../auth/presentation/guards/clinic-role-sets';
import type { TenantJwtPayload } from '../../../shared/crypto/token.service';
import { TenantContextInterceptor } from '../../../shared/tenancy/tenant-context.interceptor';
import { Audit } from '../../audit/presentation/audit.decorator';
import {
  CreateExpenseCategoryUseCase,
  DeleteExpenseCategoryUseCase,
  ListExpenseCategoriesUseCase,
  type ExpenseCategoryView,
} from '../application/use-cases/expense-categories.use-cases';
import { CreateExpenseCategoryDto } from './dto/expense-requests.dto';
import { ExpenseCategoryDto } from './dto/expense.dto';

interface AuthenticatedRequest {
  user: TenantJwtPayload;
}

// Categorías de gastos (DX-274). Leerlas para el selector: ADMIN y recepción
// (la salida de caja las usa). Crear y retirar las propias: solo ADMIN, auditado
// SIN `resourceId` (el id de una categoría no es el de un gasto). Las
// predefinidas son constantes y no se tocan.
@ApiTags('expense-categories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@UseInterceptors(TenantContextInterceptor)
@Roles(...EXPENSE_ROLES)
@Controller('expense-categories')
export class ExpenseCategoriesController {
  constructor(
    private readonly listCategories: ListExpenseCategoriesUseCase,
    private readonly createCategory: CreateExpenseCategoryUseCase,
    private readonly deleteCategory: DeleteExpenseCategoryUseCase,
  ) {}

  @Get()
  @Roles(...EXPENSE_CAPTURE_ROLES)
  @ApiOperation({
    summary: 'Categorías para el selector: predefinidas y propias activas',
  })
  @ApiOkResponse({ type: [ExpenseCategoryDto] })
  @ApiForbiddenResponse({ description: 'Solo ADMIN y recepción' })
  list(): Promise<ExpenseCategoryView[]> {
    return this.listCategories.execute();
  }

  @Audit({
    action: 'CREATE',
    resource: 'EXPENSE',
    reason: 'EXPENSE_CATEGORY_ADDED',
  })
  @Post()
  @ApiOperation({ summary: 'Crear una categoría propia' })
  @ApiCreatedResponse({ type: ExpenseCategoryDto })
  @ApiBadRequestResponse({ description: 'Nombre fuera de 2–60 caracteres' })
  @ApiConflictResponse({
    description: 'Ya existe una categoría con ese nombre',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  create(
    @Body() dto: CreateExpenseCategoryDto,
    @Req() req: AuthenticatedRequest,
  ): Promise<ExpenseCategoryView> {
    return this.createCategory.execute(dto.name, req.user.sub);
  }

  @Audit({
    action: 'DELETE',
    resource: 'EXPENSE',
    reason: 'EXPENSE_CATEGORY_REMOVED',
  })
  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({
    summary: 'Retirar una categoría propia (borrado lógico)',
    description:
      'Los gastos que la usan conservan su nombre: es una foto de texto.',
  })
  @ApiNoContentResponse({ description: 'Retirada.' })
  @ApiNotFoundResponse({
    description: 'Categoría no encontrada en esta clínica',
  })
  @ApiForbiddenResponse({ description: 'Solo ADMIN' })
  async remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.deleteCategory.execute(id);
  }
}
