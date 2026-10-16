import { randomUUID } from 'node:crypto';
import type {
  PrivacyPolicyRepository,
  PublishPolicyInput,
} from '../../../domain/ports/privacy-policy-repository.port';
import type {
  DataConsentRepository,
  RecordConsentsCommand,
} from '../../../domain/ports/data-consent-repository.port';
import type { PrivacyPolicyVersion } from '../../../domain/entities/privacy-policy.entity';
import type { DataConsentRecord } from '../../../domain/entities/data-consent.entity';

/**
 * Dobles en memoria de un solo tenant. El aislamiento (RLS), la regla de
 * "política vigente" dentro de la transacción y los triggers de inmutabilidad
 * se prueban contra Postgres en los e2e/int.
 */
export class InMemoryPrivacyPolicyRepository implements PrivacyPolicyRepository {
  readonly versions: PrivacyPolicyVersion[] = [];

  list(): Promise<PrivacyPolicyVersion[]> {
    return Promise.resolve(
      [...this.versions].sort((a, b) => b.version - a.version),
    );
  }

  publish(input: PublishPolicyInput): Promise<PrivacyPolicyVersion> {
    const { publishedById, ...content } = input;
    const version: PrivacyPolicyVersion = {
      ...content,
      id: randomUUID(),
      tenantId: 't1',
      version: this.versions.length + 1,
      publishedAt: new Date(),
      publishedBy: { id: publishedById, fullName: 'Admin' },
    };
    this.versions.push(version);
    return Promise.resolve(version);
  }
}

export class InMemoryDataConsentRepository implements DataConsentRepository {
  readonly rows: DataConsentRecord[] = [];
  readonly commands: RecordConsentsCommand[] = [];
  private clock = Date.parse('2026-10-16T10:00:00.000Z');

  listForPatient(patientId: string): Promise<DataConsentRecord[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.patientId === patientId)
        .sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime()),
    );
  }

  record(command: RecordConsentsCommand): Promise<void> {
    this.commands.push(command);
    this.clock += 60_000;
    for (const decision of command.decisions) {
      this.rows.push({
        id: randomUUID(),
        patientId: command.patientId,
        scope: decision.scope,
        granted: decision.granted,
        channel: 'IN_PERSON',
        policyVersion: { id: command.policyVersionId, version: 1 },
        legacyPolicyVersion: null,
        recordedAt: new Date(this.clock),
        recordedBy: { id: command.recordedById, fullName: 'Recepción' },
        ipAddress: command.evidence.ipAddress ?? null,
        userAgent: command.evidence.userAgent ?? null,
      });
    }
    return Promise.resolve();
  }
}
