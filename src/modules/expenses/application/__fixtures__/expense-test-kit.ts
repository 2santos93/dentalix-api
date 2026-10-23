import { createHash } from 'node:crypto';
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
