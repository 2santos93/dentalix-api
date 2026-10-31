import { ConflictException, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InMemoryFileStorage } from '../../../shared/storage/__fixtures__/in-memory-file-storage';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { JobContext } from '../../jobs/domain/job';
import {
  computeCountersignatureHash,
  computeRemoteConsentHash,
} from '../domain/consent-hash';
import type {
  ArchiveSignedConsentPdfInput,
  SignedConsentPdfJobSource,
  SignedConsentPdfRepository,
} from '../domain/ports/signed-consent-pdf-repository.port';
import type { SignedConsentPdfSource } from '../domain/signed-consent-pdf';
import type { SignedConsentPdfRenderer } from '../infrastructure/pdf/signed-consent-pdf.renderer';
import {
  GenerateSignedConsentPdf,
  RetrySignedConsentPdfUseCase,
  SIGNED_CONSENT_PDF_JOB,
  signedConsentPdfJobKey,
} from './signed-consent-pdf.service';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONSENT = '11111111-1111-4111-8111-111111111111';
const PATIENT = '22222222-2222-4222-8222-222222222222';
const LOCATION = '33333333-3333-4333-8333-333333333333';
const PRO = '44444444-4444-4444-8444-444444444444';
const SIG = 'iVBORw0KGgo=';

function signedSource(): SignedConsentPdfSource {
  const base = {
    title: 'Consentimiento — Exodoncia',
    body: 'Autorizo la exodoncia.',
    templateVersion: 1,
    signerType: 'PATIENT' as const,
    signerName: 'Laura Castro',
    signerDocument: null,
    professionalName: 'Andrés Gómez',
    patientSignature: SIG,
    signedAt: new Date('2026-10-31T18:05:00.000Z'),
    channel: 'EMAIL' as const,
    destinationMasked: 'la***@example.com',
    sentAt: new Date('2026-10-30T13:00:00.000Z'),
    openedAt: new Date('2026-10-31T17:59:00.000Z'),
    verifiedAt: new Date('2026-10-31T18:01:00.000Z'),
    ipAddress: '203.0.113.7',
    userAgent: 'UA',
  };
  const contentHash = computeRemoteConsentHash(base);
  const professionalSignedAt = new Date('2026-11-01T02:30:00.000Z');
  return {
    ...base,
    consentId: CONSENT,
    clinicName: 'Clínica Demo',
    contentHash,
    professionalSignature: SIG,
    professionalSignedAt,
    countersignatureHash: computeCountersignatureHash({
      consentHash: contentHash,
      professionalName: base.professionalName,
      professionalSignature: SIG,
      signedAt: professionalSignedAt,
    }),
    location: {
      name: 'Centro',
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h12',
    },
  };
}

class FakeRepo implements SignedConsentPdfRepository {
  job: SignedConsentPdfJobSource | null = {
    consentId: CONSENT,
    patientId: PATIENT,
    locationId: LOCATION,
    professionalUserId: PRO,
    status: 'PENDING',
    source: signedSource(),
  };
  archived: ArchiveSignedConsentPdfInput[] = [];
  failures: { code: string; final: boolean }[] = [];
  archiveError: Error | null = null;

  loadForJob(): Promise<SignedConsentPdfJobSource | null> {
    return Promise.resolve(this.job);
  }
  archive(
    input: ArchiveSignedConsentPdfInput,
  ): Promise<'ARCHIVED' | 'ALREADY_READY'> {
    if (this.archiveError) return Promise.reject(this.archiveError);
    this.archived.push(input);
    return Promise.resolve('ARCHIVED');
  }
  recordFailure(
    _consentId: string,
    failure: { code: string; final: boolean },
  ): Promise<void> {
    this.failures.push(failure);
    return Promise.resolve();
  }
}

class FakeRenderer implements SignedConsentPdfRenderer {
  fail = false;
  render(): Promise<Buffer> {
    if (this.fail) return Promise.reject(new Error('laura@example.com'));
    return Promise.resolve(Buffer.from('%PDF-1.7 fake'));
  }
}

function ctx(attempt = 1, maxAttempts = 5): JobContext {
  return {
    jobId: 'job-1',
    attempt,
    maxAttempts,
    tenantId: TENANT,
    signal: new AbortController().signal,
  };
}

function setup() {
  const repo = new FakeRepo();
  const storage = new InMemoryFileStorage();
  const renderer = new FakeRenderer();
  const tenant = new TenantContextService();
  const audit = new FakeAudit();
  const service = new GenerateSignedConsentPdf(
    repo,
    storage,
    renderer,
    tenant,
    audit,
  );
  const run = (attempt = 1, max = 5) =>
    tenant.run(TENANT, () =>
      service.handle({ consentId: CONSENT }, ctx(attempt, max)),
    );
  const exhausted = () =>
    tenant.run(TENANT, () => service.exhausted({ consentId: CONSENT }));
  return { repo, storage, renderer, run, audit, exhausted };
}

class FakeAudit {
  mismatches: { consentId: string; patientId: string }[] = [];
  integrityMismatch(consentId: string, patientId: string): Promise<void> {
    this.mismatches.push({ consentId, patientId });
    return Promise.resolve();
  }
}

describe('GenerateSignedConsentPdf (DX-422)', () => {
  it('se registra con un nombre de la cola', () => {
    expect(SIGNED_CONSENT_PDF_JOB).toBe('consents.signed-pdf');
  });

  it('genera el PDF, lo guarda en el almacén y lo archiva en los documentos del paciente', async () => {
    const { repo, storage, run } = setup();
    await run();
    expect(repo.archived).toHaveLength(1);
    const [input] = repo.archived;
    const bytes = Buffer.from('%PDF-1.7 fake');
    expect(input).toMatchObject({
      consentId: CONSENT,
      patientId: PATIENT,
      locationId: LOCATION,
      uploadedById: PRO,
      mimeType: 'application/pdf',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      originalName:
        'Consentimiento firmado - Consentimiento - Exodoncia - 2026-10-31.pdf',
    });
    expect(input.storageKey).toBe(
      `patient-documents/${TENANT}/${input.documentId}.pdf`,
    );
    expect(storage.files.get(input.storageKey)?.bytes.equals(bytes)).toBe(true);
    expect(repo.failures).toEqual([]);
  });

  it('ya archivado: no genera otro', async () => {
    const { repo, storage, run } = setup();
    repo.job = { ...repo.job!, status: 'READY' };
    await run();
    expect(repo.archived).toEqual([]);
    expect(storage.saved).toEqual([]);
  });

  it('si falla la generación, deja el código y relanza para que la cola reintente', async () => {
    const { repo, renderer, run } = setup();
    renderer.fail = true;
    await expect(run(1, 5)).rejects.toThrow();
    expect(repo.failures).toEqual([{ code: 'GENERATION_ERROR', final: false }]);
  });

  it('en el último intento queda FAILED (la ficha lo muestra)', async () => {
    const { repo, renderer, run } = setup();
    renderer.fail = true;
    await expect(run(5, 5)).rejects.toThrow();
    expect(repo.failures).toEqual([{ code: 'GENERATION_ERROR', final: true }]);
  });

  it('si no se puede crear la fila, borra el objeto guardado y reintenta', async () => {
    const { repo, storage, run } = setup();
    repo.archiveError = new Error('db');
    await expect(run()).rejects.toThrow('db');
    expect(storage.deleted).toHaveLength(1);
    expect(storage.files.size).toBe(0);
    expect(repo.failures).toEqual([{ code: 'GENERATION_ERROR', final: false }]);
  });

  it('un registro alterado no se archiva y no se reintenta (fallo definitivo)', async () => {
    const { repo, storage, run } = setup();
    repo.job = {
      ...repo.job!,
      source: { ...signedSource(), body: 'Texto cambiado por fuera' },
    };
    await run();
    expect(repo.archived).toEqual([]);
    expect(storage.saved).toEqual([]);
    expect(repo.failures).toEqual([
      { code: 'INTEGRITY_MISMATCH', final: true },
    ]);
  });

  it('M2: un registro alterado deja un evento de auditoría de sistema (solo ids) y un log de error con event estable', async () => {
    const { repo, run, audit } = setup();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation();
    repo.job = {
      ...repo.job!,
      source: { ...signedSource(), body: 'Texto cambiado por fuera' },
    };
    await run();
    expect(audit.mismatches).toEqual([
      { consentId: CONSENT, patientId: PATIENT },
    ]);
    expect(error).toHaveBeenCalledWith({
      event: 'consents.signed_pdf.integrity_mismatch',
      consentId: CONSENT,
      patientId: PATIENT,
    });
    expect(JSON.stringify(error.mock.calls)).not.toContain('Texto cambiado');
    error.mockRestore();
  });

  it('M1: si la cola agota el último intento sin ejecutarlo, queda FAILED con LEASE_EXPIRED', async () => {
    const { repo, exhausted } = setup();
    await exhausted();
    expect(repo.failures).toEqual([{ code: 'LEASE_EXPIRED', final: true }]);
  });

  it('M1: con un payload inválido el aviso no toca nada', async () => {
    const { repo } = setup();
    const tenant = new TenantContextService();
    const service = new GenerateSignedConsentPdf(
      repo,
      new InMemoryFileStorage(),
      new FakeRenderer(),
      tenant,
      new FakeAudit(),
    );
    await tenant.run(TENANT, () => service.exhausted({ consentId: 'x' }));
    expect(repo.failures).toEqual([]);
  });

  it('sin la firma del profesional (no completo) no genera nada', async () => {
    const { repo, run } = setup();
    repo.job = { ...repo.job!, source: null };
    await run();
    expect(repo.archived).toEqual([]);
    expect(repo.failures).toEqual([{ code: 'NOT_COMPLETE', final: true }]);
  });

  it('un consentimiento que no existe en esta clínica: nada que hacer', async () => {
    const { repo, run } = setup();
    repo.job = null;
    await expect(run()).resolves.toBeUndefined();
    expect(repo.archived).toEqual([]);
    expect(repo.failures).toEqual([]);
  });

  it('payload sin uuid: error sin reintento útil', async () => {
    const repo = new FakeRepo();
    const tenant = new TenantContextService();
    const service = new GenerateSignedConsentPdf(
      repo,
      new InMemoryFileStorage(),
      new FakeRenderer(),
      tenant,
      new FakeAudit(),
    );
    await expect(
      tenant.run(TENANT, () => service.handle({ consentId: 'x' }, ctx())),
    ).rejects.toThrow('payload');
  });
});

describe('RetrySignedConsentPdfUseCase (DX-422)', () => {
  function retrySetup(outcome: 'RETRYING' | 'NOT_FOUND' | 'NOT_FAILED') {
    const enqueued: { consentId: string; attempt: number }[] = [];
    const repo = {
      requestRetry: (
        _patientId: string,
        consentId: string,
        enqueue: (tx: never, attempt: number) => Promise<void>,
      ) =>
        outcome === 'RETRYING'
          ? enqueue({} as never, 6).then(() => outcome)
          : Promise.resolve(outcome),
    };
    const queue = {
      retry: (_tx: unknown, consentId: string, attempt: number) => {
        enqueued.push({ consentId, attempt });
        return Promise.resolve();
      },
    };
    return {
      enqueued,
      useCase: new RetrySignedConsentPdfUseCase(repo, queue),
    };
  }

  it('uno FAILED vuelve a PENDING y se encola con una clave nueva', async () => {
    const { useCase, enqueued } = retrySetup('RETRYING');
    await expect(useCase.execute(PATIENT, CONSENT)).resolves.toEqual({
      status: 'PENDING',
    });
    expect(enqueued).toEqual([{ consentId: CONSENT, attempt: 6 }]);
  });

  it('de otro paciente o clínica: 404; listo o generándose: 409', async () => {
    await expect(
      retrySetup('NOT_FOUND').useCase.execute(PATIENT, CONSENT),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      retrySetup('NOT_FAILED').useCase.execute(PATIENT, CONSENT),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('claves de idempotencia: la primera y una por reintento', () => {
    expect(signedConsentPdfJobKey(CONSENT)).toBe(
      `consents.signed-pdf:${CONSENT}`,
    );
    expect(signedConsentPdfJobKey(CONSENT, 6)).toBe(
      `consents.signed-pdf:${CONSENT}:retry-6`,
    );
  });
});
