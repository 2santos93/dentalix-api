import { EXPORT_CATALOG, FORBIDDEN_SQL, pageQuery } from './export-catalog';

/**
 * DX-053: reglas del catálogo de la exportación. Que cada consulta funcione
 * contra Postgres lo comprueba clinic-exports.int-spec.ts.
 */
describe('Catálogo de la exportación (DX-053)', () => {
  it('cubre lo que pide el ticket: pacientes, historia, odontograma, citas, planes, ítems, pagos, cuotas e inventario', () => {
    const files = EXPORT_CATALOG.map((t) => t.file);
    for (const file of [
      'pacientes.csv',
      'antecedentes.csv',
      'evoluciones.csv',
      'odontograma.csv',
      'citas.csv',
      'planes.csv',
      'plan-items.csv',
      'pagos.csv',
      'cuotas.csv',
      'inventario.csv',
      'inventario-movimientos.csv',
      // DX-556 y DX-172 (fuente, referente y profesional externo).
      'prospectos.csv',
      'fuentes.csv',
    ]) {
      expect(files).toContain(file);
    }
  });

  it('nombres de fichero únicos, en minúscula, .csv y sin rutas', () => {
    const files = EXPORT_CATALOG.map((t) => t.file);
    expect(new Set(files).size).toBe(files.length);
    for (const file of files) expect(file).toMatch(/^[a-z][a-z0-9-]*\.csv$/);
  });

  it('cada fichero tiene Id primero, cabeceras únicas en español y una descripción', () => {
    for (const table of EXPORT_CATALOG) {
      const headers = table.columns.map((c) => c.header);
      expect({ file: table.file, first: headers[0] }).toEqual({
        file: table.file,
        first: 'Id',
      });
      expect({ file: table.file, unique: new Set(headers).size }).toEqual({
        file: table.file,
        unique: headers.length,
      });
      expect(table.description.length).toBeGreaterThan(10);
      for (const h of headers) expect(h).not.toMatch(/^[a-z]+[A-Z]/);
    }
  });

  it('ninguna columna ni unión lee un secreto (hashes, tokens, MFA, claves del almacén, firmas, IP)', () => {
    for (const table of EXPORT_CATALOG) {
      expect({
        file: table.file,
        from: FORBIDDEN_SQL.test(table.from),
      }).toEqual({ file: table.file, from: false });
      for (const column of table.columns) {
        expect({
          file: table.file,
          header: column.header,
          forbidden: FORBIDDEN_SQL.test(column.sql),
        }).toEqual({
          file: table.file,
          header: column.header,
          forbidden: false,
        });
      }
    }
  });

  it('la regla de secretos sí atrapa lo prohibido', () => {
    for (const sql of [
      'u."passwordHash"',
      't."tokenHash"',
      'u."mfaTotpSecretEnc"',
      't."storageKey"',
      't."patientSignature"',
      't."ipAddress"',
      't."userAgent"',
      't."contentHash"',
      't."sha256"',
      't."attachmentKey"',
      't."idempotencyKey"',
      't."verificationCode"',
    ]) {
      expect({ sql, caught: FORBIDDEN_SQL.test(sql) }).toEqual({
        sql,
        caught: true,
      });
    }
    // Saber SI hay firma no es leerla.
    expect(FORBIDDEN_SQL.test('t."patientSignature" IS NOT NULL')).toBe(false);
  });

  it('nunca lee la tabla de usuarios entera: solo nombre y email del personal', () => {
    for (const table of EXPORT_CATALOG) {
      const sql = [table.from, ...table.columns.map((c) => c.sql)].join(' ');
      for (const match of sql.matchAll(/\bu\."(\w+)"/g)) {
        expect(['id', 'fullName', 'email']).toContain(match[1]);
      }
    }
  });

  it('cada unión a una tabla de clínica exige su misma clínica (salvo users, cities y tenants)', () => {
    const GLOBAL = new Set(['users', 'cities', 'tenants']);
    for (const table of EXPORT_CATALOG) {
      const joins = table.from.split(/\b(?:LEFT\s+)?JOIN\b/).slice(1);
      for (const join of joins) {
        const name = /^\s*"(\w+)"/.exec(join)?.[1];
        expect(name).toBeDefined();
        if (GLOBAL.has(name!)) continue;
        expect({
          file: table.file,
          join: join.trim(),
          tenant: /"tenantId" = t\."tenantId"/.test(join),
        }).toEqual({
          file: table.file,
          join: join.trim(),
          tenant: true,
        });
      }
      // Subconsultas de nombres: también acotadas por la clínica de la fila
      // (salvo los usuarios, globales).
      for (const column of table.columns) {
        for (const sub of column.sql.matchAll(/FROM "(\w+)" (\w+)/g)) {
          if (GLOBAL.has(sub[1])) continue;
          expect({
            file: table.file,
            header: column.header,
            tenant: column.sql.includes(`${sub[2]}."tenantId" = t."tenantId"`),
          }).toEqual({
            file: table.file,
            header: column.header,
            tenant: true,
          });
        }
      }
    }
  });

  it('los importes dicen su moneda y llevan una columna «Moneda» en su fichero', () => {
    for (const table of EXPORT_CATALOG) {
      const amounts = table.columns.filter((c) => c.kind === 'amount');
      for (const a of amounts) expect(a.currency).toBeTruthy();
      if (amounts.length > 0) {
        expect({
          file: table.file,
          moneda: table.columns.some((c) => c.header === 'Moneda'),
        }).toEqual({ file: table.file, moneda: true });
      }
    }
  });

  it('la página: filtro explícito de clínica, keyset por id, tamaño como parámetro y sin nada interpolado', () => {
    for (const table of EXPORT_CATALOG) {
      const sql = pageQuery(table);
      expect(sql).toContain(
        `WHERE t."tenantId" = $1::uuid AND ($2::uuid IS NULL OR t."id" > $2::uuid)`,
      );
      expect(sql).toContain('ORDER BY t."id"');
      expect(sql.trim().endsWith('LIMIT $3')).toBe(true);
      expect(sql).not.toMatch(/\$[4-9]/);
      expect(sql).not.toMatch(/;/);
    }
  });
});
