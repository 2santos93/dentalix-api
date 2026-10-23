import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('DX-246: índices de FK sin bloqueo largo', () => {
  it.each([
    [
      '20261023120000_dx246_delivery_fk_indexes',
      'template_idx',
      '"tenantId", "templateId"',
    ],
    [
      '20261023120100_dx246_delivery_location_fk_index',
      'location_idx',
      '"tenantId", "locationId"',
    ],
    [
      '20261023120200_dx246_delivery_delivered_by_fk_index',
      'delivered_by_idx',
      '"deliveredById"',
    ],
  ])(
    '%s contiene un índice concurrente independiente',
    (migration, suffix, columns) => {
      const sql = readFileSync(
        join(__dirname, '../../prisma/migrations', migration, 'migration.sql'),
        'utf8',
      )
        .replace(/--[^\n]*/g, '')
        .trim();
      expect(sql.split(';').filter((s) => s.trim())).toHaveLength(1);
      expect(sql).toBe(
        `CREATE INDEX CONCURRENTLY IF NOT EXISTS "post_op_instruction_deliveries_${suffix}" ON "post_op_instruction_deliveries" (${columns});`,
      );
    },
  );
});
