import type {
  PublicSignatureContext,
  SignatureRequestListRow,
  SignatureRequestRecord,
} from '../../domain/entities/signature-request.entity';
import type {
  CreateSignatureRequestRepoInput,
  LockedWrite,
  PublicRequestEvidence,
  PublicSignatureAuditEvent,
  RemoteConsentInsert,
  RevokeOutcome,
  SignatureRecipientContext,
  SignatureRequestRepository,
} from '../../domain/ports/signature-request-repository.port';

/**
 * Repositorio de firma a distancia en memoria (DX-243). `recipients` hace de
 * la RLS: un paciente que no está ahí «es de otra clínica». Guarda los
 * consentimientos que produce la firma y los eventos del paciente, como la
 * transacción real.
 */
export class InMemorySignatureRequestRepository implements SignatureRequestRepository {
  readonly rows: SignatureRequestRecord[] = [];
  readonly consents: (RemoteConsentInsert & {
    id: string;
    patientId: string;
    signatureRequestId: string;
  })[] = [];
  readonly audits: (PublicSignatureAuditEvent & {
    requestId: string;
    evidence: PublicRequestEvidence;
  })[] = [];
  readonly countersigned = new Set<string>();
  professionals: { id: string; fullName: string }[] = [
    { id: 'dentist-1', fullName: 'Dra. Laura Gómez' },
  ];
  clinic = { name: 'Clínica Demo', logoUrl: null, primaryColor: '#0E7490' };
  location = {
    timeZone: 'America/Bogota',
    locale: 'es-CO',
    hourCycle: 'h12',
  };
  private nextId = 1;

  constructor(
    readonly recipients: Record<string, SignatureRecipientContext> = {},
  ) {}

  loadRecipientContext(
    patientId: string,
  ): Promise<SignatureRecipientContext | null> {
    return Promise.resolve(this.recipients[patientId] ?? null);
  }

  findProfessional(
    userId: string,
  ): Promise<{ id: string; fullName: string } | null> {
    return Promise.resolve(
      this.professionals.find((p) => p.id === userId) ?? null,
    );
  }

  listProfessionals(): Promise<{ id: string; fullName: string }[]> {
    return Promise.resolve([...this.professionals]);
  }

  create(
    input: CreateSignatureRequestRepoInput,
  ): Promise<{ id: string; supersededIds: string[] }> {
    const supersededIds: string[] = [];
    for (const row of this.rows) {
      if (
        row.patientId === input.patientId &&
        row.templateId === input.templateId &&
        !row.signedAt &&
        !row.revokedAt
      ) {
        row.revokedAt = input.createdAt;
        supersededIds.push(row.id);
      }
    }
    const id = `00000000-0000-4000-8000-${String(this.nextId++).padStart(12, '0')}`;
    this.rows.push({
      id,
      tenantId: 't1',
      ...input,
      codeHash: null,
      codeExpiresAt: null,
      codeSentAt: null,
      codeSendCount: 0,
      failedAttempts: 0,
      lockedAt: null,
      sessionHash: null,
      sessionExpiresAt: null,
      openedAt: null,
      verifiedAt: null,
      signedAt: null,
      revokedAt: null,
    });
    return Promise.resolve({ id, supersededIds });
  }

  private listRow(request: SignatureRequestRecord): SignatureRequestListRow {
    const consent = this.consents.find(
      (c) => c.signatureRequestId === request.id,
    );
    return {
      request: { ...request },
      sentByName: 'Recepción Demo',
      consent: consent
        ? {
            id: consent.id,
            ipAddress: consent.ipAddress,
            countersignedAt: this.countersigned.has(consent.id)
              ? consent.signedAt
              : null,
          }
        : null,
    };
  }

  listByPatient(
    patientId: string,
    limit: number,
  ): Promise<SignatureRequestListRow[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.patientId === patientId)
        .reverse()
        .slice(0, limit)
        .map((r) => this.listRow(r)),
    );
  }

  findById(id: string): Promise<SignatureRequestListRow | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(row ? this.listRow(row) : null);
  }

  revoke(input: {
    id: string;
    revokedById: string;
    now: Date;
  }): Promise<RevokeOutcome> {
    const row = this.rows.find((r) => r.id === input.id);
    if (!row) return Promise.resolve('NOT_FOUND');
    if (row.signedAt || row.revokedAt) return Promise.resolve('NOT_PENDING');
    row.revokedAt = input.now;
    row.sessionHash = null;
    row.sessionExpiresAt = null;
    return Promise.resolve('REVOKED');
  }

  findByTokenHash(tokenHash: string): Promise<PublicSignatureContext | null> {
    const row = this.rows.find((r) => r.tokenHash === tokenHash);
    return Promise.resolve(
      row
        ? { request: { ...row }, clinic: this.clinic, location: this.location }
        : null,
    );
  }

  withLockedRequest<T>(
    id: string,
    evidence: PublicRequestEvidence,
    decide: (request: SignatureRequestRecord) => {
      write: LockedWrite | null;
      result: T;
    },
  ): Promise<T | null> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return Promise.resolve(null);
    const { write, result } = decide({ ...row });
    if (write) {
      Object.assign(row, write.patch);
      if (write.consent) {
        this.consents.push({
          id: `pc-${this.consents.length + 1}`,
          patientId: row.patientId,
          signatureRequestId: row.id,
          ...write.consent,
        });
      }
      for (const event of write.audit) {
        this.audits.push({ ...event, requestId: row.id, evidence });
      }
    }
    return Promise.resolve(result);
  }
}
