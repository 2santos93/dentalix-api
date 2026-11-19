import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// DX-565: textos de los mensajes al paciente editables. Una migración
// aditiva: una tabla nueva (nace vacía) con sus FK DENTRO del CREATE TABLE,
// RLS FORCE con NULLIF y sin TRUNCATE para la app. Nada se borra, renombra ni
// recorre; lock_timeout antes de la primera sentencia.

const MIGRATION = '20270119140000_dx565_message_templates';

const code = (): string =>
  readFileSync(
    join(__dirname, '../../prisma/migrations', MIGRATION, 'migration.sql'),
    'utf8',
  )
    .replace(/--[^\n]*/g, '')
    .trim();

describe('DX-565: migración aditiva', () => {
  it('fija lock_timeout antes de la primera sentencia', () => {
    expect(code()).toMatch(/^SET LOCAL lock_timeout = '5s';/);
  });

  it('no borra, renombra, recorre ni toca nada existente', () => {
    expect(code()).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|SET\s+NOT\s+NULL|^\s*TRUNCATE\b|DELETE\s+FROM|^\s*UPDATE\b|DISABLE\s+TRIGGER|ALTER\s+TYPE|ALTER TABLE "(?!message_templates")/im,
    );
  });

  it('la tabla: sin paciente, FK directa a tenants y a users RESTRICT, topes y UNIQUE por clave, canal e idioma', () => {
    const sql = code().replace(/\s+/g, ' ');
    const table = /CREATE TABLE "message_templates" \((.*?)\);/.exec(sql)![1];
    expect(table).not.toMatch(/patientId/);
    expect(table).toContain(
      'CONSTRAINT "message_templates_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT',
    );
    expect(table).toContain(
      'CONSTRAINT "message_templates_updated_by_fkey" FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE RESTRICT',
    );
    expect(table).toContain(`CHECK ("channel" IN ('EMAIL', 'WHATSAPP'))`);
    expect(table).toContain(`CHECK ("language" IN ('es', 'en'))`);
    expect(table).toContain('char_length("subject") BETWEEN 1 AND 150');
    expect(table).toContain('CHECK (char_length("body") BETWEEN 1 AND 2000)');
    expect(sql).toContain(
      'CREATE UNIQUE INDEX "message_templates_tenant_key_channel_language_key" ON "message_templates"("tenantId", "key", "channel", "language");',
    );
    expect(sql).not.toContain('dx_patient_merge_tables');
    expect(sql).not.toMatch(/NOT VALID|VALIDATE CONSTRAINT/);
  });

  it('RLS ENABLE + FORCE con NULLIF y sin TRUNCATE para la app', () => {
    const sql = code().replace(/\s+/g, ' ');
    expect(sql).toContain(
      'ALTER TABLE "message_templates" ENABLE ROW LEVEL SECURITY;',
    );
    expect(sql).toContain(
      'ALTER TABLE "message_templates" FORCE ROW LEVEL SECURITY;',
    );
    expect(
      sql.match(
        /NULLIF\(current_setting\('app\.current_tenant', true\), ''\)::uuid/g,
      )!.length,
    ).toBe(2);
    expect(sql).toContain(
      'REVOKE TRUNCATE ON "message_templates" FROM dentalix_app;',
    );
  });
});
