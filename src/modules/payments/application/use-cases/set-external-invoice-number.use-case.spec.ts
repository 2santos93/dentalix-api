import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type {
  ExternalInvoiceRepository,
  SetExternalInvoiceOutcome,
} from '../../domain/ports/external-invoice-repository.port';
import {
  EXTERNAL_INVOICE_VOIDED_MESSAGE,
  SetExternalInvoiceNumberUseCase,
} from './set-external-invoice-number.use-case';

const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'u1', role: 'RECEPTION' },
  requestId: null,
  ip: null,
  userAgent: null,
};

function repoReturning(outcome: SetExternalInvoiceOutcome) {
  const calls: (string | null)[] = [];
  const repo: ExternalInvoiceRepository = {
    set: (_id, value) => {
      calls.push(value);
      return Promise.resolve(outcome);
    },
  };
  return { repo, calls };
}

const SAVED = (value: string | null): SetExternalInvoiceOutcome => ({
  kind: 'saved',
  result: { paymentId: 'p1', externalInvoiceNumber: value, paymentIds: ['p1'] },
});

describe('SetExternalInvoiceNumberUseCase (DX-515)', () => {
  it('guarda el texto recortado, sin exigir formato', async () => {
    const { repo, calls } = repoReturning(SAVED('A/2026-0007'));
    await new SetExternalInvoiceNumberUseCase(repo).execute(
      'p1',
      '  A/2026-0007 ',
      CTX,
    );
    expect(calls).toEqual(['A/2026-0007']);
  });

  it('vacío o null lo quitan', async () => {
    const { repo, calls } = repoReturning(SAVED(null));
    const uc = new SetExternalInvoiceNumberUseCase(repo);
    await uc.execute('p1', '', CTX);
    await uc.execute('p1', null, CTX);
    expect(calls).toEqual([null, null]);
  });

  it('400 con saltos de línea o más de 64 caracteres, sin escribir', async () => {
    const { repo, calls } = repoReturning(SAVED('x'));
    const uc = new SetExternalInvoiceNumberUseCase(repo);
    await expect(uc.execute('p1', 'a\nb', CTX)).rejects.toThrow(
      BadRequestException,
    );
    await expect(uc.execute('p1', 'x'.repeat(65), CTX)).rejects.toThrow(
      BadRequestException,
    );
    expect(calls).toEqual([]);
  });

  it('404 si no existe (o es de otra clínica) y 409 si está anulado', async () => {
    await expect(
      new SetExternalInvoiceNumberUseCase(
        repoReturning({ kind: 'not-found' }).repo,
      ).execute('p1', 'F-1', CTX),
    ).rejects.toThrow(NotFoundException);
    await expect(
      new SetExternalInvoiceNumberUseCase(
        repoReturning({ kind: 'voided' }).repo,
      ).execute('p1', 'F-1', CTX),
    ).rejects.toThrow(new ConflictException(EXTERNAL_INVOICE_VOIDED_MESSAGE));
  });
});
