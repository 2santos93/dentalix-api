import { ConflictException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { ExpensePayment } from '../../domain/entities/expense.entity';
import { OPEN_CASH_SESSION_REQUIRED_MESSAGE } from '../../domain/expense-rules';
import type {
  ExpenseCashContext,
  ExpenseCashLink,
} from '../../domain/ports/expense-cash-link.port';
import { InMemoryFileStorage } from '../../../../shared/storage/__fixtures__/in-memory-file-storage';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { ExpenseCategoryResolver } from '../expense-category-resolver';
import { ExpenseReceiptUploads } from '../expense-receipt-uploads';
import {
  InMemoryExpenseCategoryRepository,
  InMemoryExpenseRepository,
  KNOWN_CURRENCIES,
  TENANT_ID,
} from './in-memory-expenses';

export const NOW = new Date('2026-10-23T15:00:00.000Z');
export const clock = () => NOW;
export const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const RECEPTION = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/** Lo común a los tests de casos de uso: repos y almacén en memoria. */
export interface ExpenseTestKit {
  repo: InMemoryExpenseRepository;
  categories: InMemoryExpenseCategoryRepository;
  storage: InMemoryFileStorage;
  tenant: TenantContextService;
  resolver: ExpenseCategoryResolver;
  receipts: ExpenseReceiptUploads;
  whitelist: typeof KNOWN_CURRENCIES;
  /** Corre `fn` con la clínica en el contexto (como el interceptor). */
  inTenant<T>(fn: () => T): T;
}

export function buildExpenseTestKit(): ExpenseTestKit {
  const repo = new InMemoryExpenseRepository();
  const categories = new InMemoryExpenseCategoryRepository();
  const storage = new InMemoryFileStorage();
  const tenant = new TenantContextService();
  return {
    repo,
    categories,
    storage,
    tenant,
    resolver: new ExpenseCategoryResolver(categories),
    receipts: new ExpenseReceiptUploads(storage, tenant, 900),
    whitelist: KNOWN_CURRENCIES,
    inTenant: (fn) => tenant.run(TENANT_ID, fn),
  };
}

export const sha256Of = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/**
 * El navegador completo: pide la autorización, deja `bytes` en la clave
 * pendiente (con los metadatos firmados) y devuelve el `uploadId`.
 */
export async function uploadReceipt(
  kit: ExpenseTestKit,
  bytes: Buffer,
  declared: { name?: string; mimeType?: string } = {
    name: 'factura.pdf',
    mimeType: 'application/pdf',
  },
  userId = ADMIN,
): Promise<string> {
  const ticket = await kit.inTenant(() =>
    kit.receipts.authorize(
      { ...declared, size: bytes.length, sha256: sha256Of(bytes) },
      userId,
    ),
  );
  const key = [...kit.storage.directUploads.keys()].find((k) =>
    k.endsWith(ticket.uploadId),
  )!;
  kit.storage.simulateDirectUpload(key, bytes);
  return ticket.uploadId;
}

/**
 * Caja en memoria (DX-274): `open` dice qué usuario tiene caja abierta en qué
 * sede. Toma la caja como `ExpenseCashSession` (409 sin caja) y apunta las
 * anulaciones que le llegan.
 */
export class FakeCashLink implements ExpenseCashLink {
  /** `${userId}|${locationId}` → id de la caja abierta. */
  readonly open = new Map<string, string>();
  readonly attached: ExpenseCashContext[] = [];
  readonly voided: { paymentId: string; reason: string; by: string }[] = [];
  /** Las sedes que pidió el último `openSessionLocations`. */
  lastScope: readonly string[] | undefined | null = null;

  openSession(userId: string, locationId: string, id = randomUUID()): string {
    this.open.set(`${userId}|${locationId}`, id);
    return id;
  }

  attachToOpenSession(_tx: unknown, ctx: ExpenseCashContext): Promise<string> {
    const id = this.open.get(`${ctx.userId}|${ctx.locationId}`);
    if (!id) {
      return Promise.reject(
        new ConflictException(OPEN_CASH_SESSION_REQUIRED_MESSAGE),
      );
    }
    this.attached.push(ctx);
    return Promise.resolve(id);
  }

  openSessionLocations(
    userId: string,
    locationIds: readonly string[] | undefined,
  ): Promise<string[]> {
    this.lastScope = locationIds;
    return Promise.resolve(
      [...this.open.keys()]
        .filter((key) => key.startsWith(`${userId}|`))
        .map((key) => key.split('|')[1])
        .filter((loc) => !locationIds || locationIds.includes(loc)),
    );
  }

  onPaymentVoided(
    _tx: unknown,
    payment: ExpensePayment,
    reason: string,
    by: string,
  ): Promise<void> {
    this.voided.push({ paymentId: payment.id, reason, by });
    return Promise.resolve();
  }
}
