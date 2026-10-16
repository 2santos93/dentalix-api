import {
  AUDIT_MIN_RETENTION_MONTHS,
  loadAuditPartitionConfig,
} from './audit-retention-config';

const env =
  (vars: Record<string, string>) =>
  (key: string): string | undefined =>
    vars[key];

describe('loadAuditPartitionConfig (DX-102)', () => {
  it('por defecto: 15 años de retención, 12 meses de horizonte y barrido diario', () => {
    expect(loadAuditPartitionConfig(env({}))).toEqual({
      retentionMonths: 180,
      monthsAhead: 12,
      maintenanceIntervalMs: 86_400_000,
    });
    expect(AUDIT_MIN_RETENTION_MONTHS).toBe(180);
  });

  it('en test el barrido periódico va apagado salvo que se pida', () => {
    expect(
      loadAuditPartitionConfig(env({ NODE_ENV: 'test' })).maintenanceIntervalMs,
    ).toBe(0);
  });

  it('respeta valores válidos del entorno', () => {
    expect(
      loadAuditPartitionConfig(
        env({
          AUDIT_RETENTION_MONTHS: '240',
          AUDIT_PARTITIONS_MONTHS_AHEAD: '24',
          AUDIT_PARTITIONS_INTERVAL_MS: '3600000',
        }),
      ),
    ).toEqual({
      retentionMonths: 240,
      monthsAhead: 24,
      maintenanceIntervalMs: 3_600_000,
    });
  });

  it('nunca baja la retención del mínimo legal ni sale de 1..36 meses de horizonte', () => {
    const cfg = loadAuditPartitionConfig(
      env({
        AUDIT_RETENTION_MONTHS: '12',
        AUDIT_PARTITIONS_MONTHS_AHEAD: '99',
      }),
    );
    expect(cfg.retentionMonths).toBe(180);
    expect(cfg.monthsAhead).toBe(36);
    expect(
      loadAuditPartitionConfig(env({ AUDIT_PARTITIONS_MONTHS_AHEAD: '0' }))
        .monthsAhead,
    ).toBe(1);
  });
});
