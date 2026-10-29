import { BadRequestException } from '@nestjs/common';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { DocumentTypeNames } from '../../domain/document-type-names';
import type { DocumentTypeNamesRepository } from '../../domain/ports/document-type-names-repository.port';
import {
  GetDocumentTypeNamesUseCase,
  UpdateDocumentTypeNamesUseCase,
} from './document-type-names.use-cases';

const NONE: DocumentTypeNames = {
  NATIONAL_ID: null,
  PASSPORT: null,
  RESIDENCE_PERMIT: null,
  TAX_ID: null,
  OTHER: null,
};

class InMemoryDocumentTypeNamesRepository implements DocumentTypeNamesRepository {
  names: DocumentTypeNames = { ...NONE };
  writes = 0;

  get(): Promise<DocumentTypeNames> {
    return Promise.resolve({ ...this.names });
  }

  set(
    names: DocumentTypeNames,
  ): Promise<{ before: DocumentTypeNames; after: DocumentTypeNames }> {
    const before = this.names;
    this.names = { ...names };
    this.writes += 1;
    return Promise.resolve({ before, after: { ...names } });
  }
}

describe('Nombres locales de los tipos de documento (DX-327, R16)', () => {
  let repo: InMemoryDocumentTypeNamesRepository;
  const audit = { record: jest.fn() };
  const ctx: AuditRequestContext = {
    tenantId: 't-1',
    locationId: 'l-1',
    actor: { userId: 'u-admin', role: 'ADMIN' },
    requestId: 'req-1',
    ip: null,
    userAgent: null,
  };
  const update = () =>
    new UpdateDocumentTypeNamesUseCase(
      repo,
      audit as unknown as RecordAuditEventUseCase,
    );

  beforeEach(() => {
    repo = new InMemoryDocumentTypeNamesRepository();
    audit.record.mockReset();
  });

  it('reads the clinic names', async () => {
    repo.names = { ...NONE, TAX_ID: 'ID local' };
    await expect(
      new GetDocumentTypeNamesUseCase(repo).execute(),
    ).resolves.toEqual({ names: { ...NONE, TAX_ID: 'ID local' } });
  });

  it('update audits CLINIC_SETTINGS with DOCUMENT_TYPE_NAMES_SETTINGS and the changed types, never the values', async () => {
    repo.names = { ...NONE, OTHER: 'Documento B', TAX_ID: 'Documento C' };
    await expect(
      update().execute(
        { NATIONAL_ID: ' ID  local ', TAX_ID: 'Documento C' },
        ctx,
      ),
    ).resolves.toEqual({
      names: { ...NONE, NATIONAL_ID: 'ID local', TAX_ID: 'Documento C' },
    });
    expect(audit.record).toHaveBeenCalledTimes(1);
    expect(audit.record).toHaveBeenCalledWith({
      tenantId: 't-1',
      locationId: 'l-1',
      actor: { kind: 'user', userId: 'u-admin', role: 'ADMIN' },
      action: 'UPDATE',
      resourceType: 'CLINIC_SETTINGS',
      resourceId: null,
      patient: null,
      requestId: 'req-1',
      ip: null,
      userAgent: null,
      metadata: {
        reason: 'DOCUMENT_TYPE_NAMES_SETTINGS',
        changedFields: ['NATIONAL_ID', 'OTHER'],
      },
    });
    const event = JSON.stringify(audit.record.mock.calls[0]);
    for (const value of ['ID local', 'Documento B', 'Documento C']) {
      expect(event).not.toContain(value);
    }
  });

  it('update without changes records no event', async () => {
    repo.names = { ...NONE, PASSPORT: 'Documento A' };
    await expect(
      update().execute({ PASSPORT: '  Documento   A ' }, ctx),
    ).resolves.toEqual({ names: { ...NONE, PASSPORT: 'Documento A' } });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('an ambiguous set is 400 and nothing is saved', async () => {
    repo.names = { ...NONE, OTHER: 'Documento B' };
    for (const input of [
      { NATIONAL_ID: 'Nombre Local', PASSPORT: 'nombre-local' },
      { NATIONAL_ID: 'Pasaporte' },
      { NATIONAL_ID: '---' },
    ]) {
      const error = await update()
        .execute(input, ctx)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as BadRequestException).message).toMatch(
        /ya es el nombre de|Elige otro|al menos una letra/,
      );
    }
    expect(repo.writes).toBe(0);
    expect(repo.names).toEqual({ ...NONE, OTHER: 'Documento B' });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
