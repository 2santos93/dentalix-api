import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { TokenService } from '../../shared/crypto/token.service';
import { StorageModule } from '../../shared/storage/storage.module';
import { TenantContextInterceptor } from '../../shared/tenancy/tenant-context.interceptor';
import { CURRENCY_WHITELIST } from '../treatment-plans/domain/ports/currency-whitelist.port';
import { PrismaCurrencyWhitelist } from '../treatment-plans/infrastructure/adapters/prisma-currency-whitelist.adapter';
import { ExpenseCategoryResolver } from './application/expense-category-resolver';
import { ExpenseReceiptUploads } from './application/expense-receipt-uploads';
import {
  EXPENSE_CLOCK,
  EXPENSE_RECEIPT_UPLOAD_TTL,
  EXPENSE_RECEIPT_URL_TTL,
} from './application/expense-tokens';
import { AddExpensePaymentUseCase } from './application/use-cases/add-expense-payment.use-case';
import { AttachExpenseReceiptUseCase } from './application/use-cases/attach-expense-receipt.use-case';
import { CreateExpenseUploadUseCase } from './application/use-cases/create-expense-upload.use-case';
import { CreateExpenseUseCase } from './application/use-cases/create-expense.use-case';
import {
  CreateExpenseCategoryUseCase,
  DeleteExpenseCategoryUseCase,
  ListExpenseCategoriesUseCase,
} from './application/use-cases/expense-categories.use-cases';
import { GetExpenseReceiptUrlUseCase } from './application/use-cases/get-expense-receipt-url.use-case';
import { GetExpenseUseCase } from './application/use-cases/get-expense.use-case';
import { ListExpensesUseCase } from './application/use-cases/list-expenses.use-case';
import { SuggestSuppliersUseCase } from './application/use-cases/suggest-suppliers.use-case';
import { UpdateExpenseUseCase } from './application/use-cases/update-expense.use-case';
import { VoidExpensePaymentUseCase } from './application/use-cases/void-expense-payment.use-case';
import { VoidExpenseUseCase } from './application/use-cases/void-expense.use-case';
import {
  RECEIPT_UPLOAD_TTL_SECONDS,
  RECEIPT_URL_TTL_SECONDS,
} from './domain/expense-receipt';
import { EXPENSE_CATEGORY_REPOSITORY } from './domain/ports/expense-category-repository.port';
import { EXPENSE_REPOSITORY } from './domain/ports/expense-repository.port';
import { PrismaExpenseCategoryRepository } from './infrastructure/repositories/prisma-expense-category.repository';
import { PrismaExpenseRepository } from './infrastructure/repositories/prisma-expense.repository';
import { ExpenseCategoriesController } from './presentation/expense-categories.controller';
import { ExpensesController } from './presentation/expenses.controller';

/**
 * Gastos de la sede (DX-274): factura o cuenta por pagar con categoría,
 * proveedor, fechas y soporte; pagos totales o parciales; anulación sin
 * borrar. Estado derivado de los pagos. El soporte sube directo al almacén
 * (`expense-receipts/`). Exporta el repositorio y los servicios de soporte y
 * categorías para que la caja registre salidas de caja menor sin repetirlos
 * (`CashSessionsModule` → `ExpensesModule`, en un solo sentido).
 */
@Module({
  imports: [JwtModule.register({}), StorageModule],
  controllers: [ExpensesController, ExpenseCategoriesController],
  providers: [
    ListExpensesUseCase,
    GetExpenseUseCase,
    CreateExpenseUseCase,
    UpdateExpenseUseCase,
    VoidExpenseUseCase,
    AddExpensePaymentUseCase,
    VoidExpensePaymentUseCase,
    CreateExpenseUploadUseCase,
    AttachExpenseReceiptUseCase,
    GetExpenseReceiptUrlUseCase,
    SuggestSuppliersUseCase,
    ListExpenseCategoriesUseCase,
    CreateExpenseCategoryUseCase,
    DeleteExpenseCategoryUseCase,
    ExpenseCategoryResolver,
    ExpenseReceiptUploads,
    TokenService,
    TenantContextInterceptor,
    { provide: EXPENSE_CLOCK, useValue: () => new Date() },
    { provide: EXPENSE_RECEIPT_URL_TTL, useValue: RECEIPT_URL_TTL_SECONDS },
    {
      provide: EXPENSE_RECEIPT_UPLOAD_TTL,
      useValue: RECEIPT_UPLOAD_TTL_SECONDS,
    },
    { provide: CURRENCY_WHITELIST, useClass: PrismaCurrencyWhitelist },
    { provide: EXPENSE_REPOSITORY, useClass: PrismaExpenseRepository },
    {
      provide: EXPENSE_CATEGORY_REPOSITORY,
      useClass: PrismaExpenseCategoryRepository,
    },
  ],
  exports: [
    EXPENSE_REPOSITORY,
    EXPENSE_CLOCK,
    ExpenseCategoryResolver,
    ExpenseReceiptUploads,
  ],
})
export class ExpensesModule {}
