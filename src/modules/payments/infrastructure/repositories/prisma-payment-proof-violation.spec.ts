import { Prisma } from '@prisma/client';
import { isProofUploadReuse } from './prisma-payment.repository';

function p2002(meta: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('unique', {
    code: 'P2002',
    clientVersion: 'test',
    meta,
  });
}

describe('isProofUploadReuse (DX-389)', () => {
  it('reconoce el único de la subida por sus campos o por el nombre del índice', () => {
    expect(
      isProofUploadReuse(p2002({ target: ['tenantId', 'uploadId'] })),
    ).toBe(true);
    expect(
      isProofUploadReuse(p2002({ target: 'payment_proofs_tenant_upload_key' })),
    ).toBe(true);
    expect(
      isProofUploadReuse(
        p2002({
          driverAdapterError: {
            cause: { constraint: 'payment_proofs_tenant_upload_key' },
          },
        }),
      ),
    ).toBe(true);
  });

  it('otro único de la tabla (p. ej. la clave) o un error que no es un único no cuentan', () => {
    expect(isProofUploadReuse(p2002({ target: ['key'] }))).toBe(false);
    expect(
      isProofUploadReuse(p2002({ target: 'payment_proofs_key_key' })),
    ).toBe(false);
    expect(isProofUploadReuse(new Error('x'))).toBe(false);
  });
});
