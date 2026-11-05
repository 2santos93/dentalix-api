import { createHash } from 'node:crypto';
import { InMemoryFileStorage } from '../../../../shared/storage/__fixtures__/in-memory-file-storage';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { PaymentRepository } from '../../domain/ports/payment-repository.port';
import { PaymentProofUploads } from '../payment-proof-uploads';
import { PaymentProofs } from '../payment-proofs';

export const PROOF_TENANT_ID = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
export const PROOF_USER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

export const sha256Of = (bytes: Buffer): string =>
  createHash('sha256').update(bytes).digest('hex');

/** Almacén y servicios del comprobante en memoria (DX-389), para los specs. */
export interface PaymentProofKit {
  storage: InMemoryFileStorage;
  tenant: TenantContextService;
  uploads: PaymentProofUploads;
  proofs: PaymentProofs;
  /** Corre `fn` con la clínica en el contexto (como el interceptor). */
  inTenant<T>(fn: () => T): T;
  /** El navegador completo: autoriza, deja `bytes` y devuelve el `uploadId`. */
  upload(
    bytes: Buffer,
    declared?: { name?: string; mimeType?: string },
    userId?: string,
  ): Promise<string>;
}

export function buildPaymentProofKit(repo: PaymentRepository): PaymentProofKit {
  const storage = new InMemoryFileStorage();
  const tenant = new TenantContextService();
  const uploads = new PaymentProofUploads(storage, tenant, 900);
  const kit: PaymentProofKit = {
    storage,
    tenant,
    uploads,
    proofs: new PaymentProofs(uploads, repo),
    inTenant: (fn) => tenant.run(PROOF_TENANT_ID, fn),
    upload: async (
      bytes,
      declared = { name: 'captura.png', mimeType: 'image/png' },
      userId = PROOF_USER,
    ) => {
      const ticket = await kit.inTenant(() =>
        uploads.authorize(
          { ...declared, size: bytes.length, sha256: sha256Of(bytes) },
          userId,
        ),
      );
      const key = [...storage.directUploads.keys()].find((k) =>
        k.endsWith(ticket.uploadId),
      )!;
      storage.simulateDirectUpload(key, bytes);
      return ticket.uploadId;
    },
  };
  return kit;
}
