import { Prisma } from '@prisma/client';
import {
  balancePatientsByDocSql,
  existingBalancesByDocSql,
  existingDocsSql,
  knownDocsInFileSql,
  knownDocsPatientsSql,
  patientsToFillByDocSql,
} from './patient-doc-queries';
import { livePatientWithDocSql } from '../../patients/infrastructure/patient-doc-lock';

// DX-287 (DB-047): toda búsqueda de pacientes por documento normalizado
// compara la COLUMNA "docKey" (texteq, LEAKPROOF: condición de índice bajo
// RLS) y lleva el predicado del índice parcial
// patients_tenant_doc_key_live_idx ("deletedAt" IS NULL AND "docNumber" IS
// NOT NULL). Nunca la expresión regular por fila, que bajo RLS FORCE se queda
// en Filter y recorre todos los pacientes de la clínica.
const TENANT = '00000000-0000-4000-8000-000000000001';
const BATCH = '00000000-0000-4000-8000-000000000002';
const KEYS = ['1111111', 'AB12345'];

const flat = (sql: Prisma.Sql) => sql.sql.replace(/\s+/g, ' ');

describe('consultas por documento normalizado (DX-287)', () => {
  const onPatients: [string, Prisma.Sql][] = [
    [
      'livePatientWithDoc (alta y edición)',
      livePatientWithDocSql(TENANT, '1111111'),
    ],
    ['existingDocs (dry-run)', existingDocsSql(TENANT, KEYS)],
    ['knownDocs (hoja de saldos)', knownDocsPatientsSql(TENANT, KEYS)],
    [
      'existingBalances',
      existingBalancesByDocSql(TENANT, BATCH, KEYS, 'America/Bogota'),
    ],
    ['processBalanceChunk', balancePatientsByDocSql(TENANT, KEYS)],
    [
      'applyRows (bloque de 250, FOR UPDATE)',
      patientsToFillByDocSql(TENANT, KEYS),
    ],
  ];

  it.each(onPatients)(
    '%s compara "docKey" con el predicado del índice parcial y sin regexp_replace',
    (_label, sql) => {
      const text = flat(sql);
      expect(text).toMatch(/"docKey" = (ANY\()?\?/);
      expect(text).not.toMatch(/regexp_replace|upper\(|dx_doc_key/i);
      expect(text).toMatch(/"deletedAt" IS NULL/);
      expect(text).toMatch(/"docNumber" IS NOT NULL/);
      expect(text).toMatch(/"tenantId" = \?::uuid/);
      expect(sql.values).toContain(TENANT);
    },
  );

  it('las claves viajan como un único array de texto (= ANY), nunca una consulta por clave', () => {
    for (const [, sql] of onPatients.slice(1)) {
      expect(flat(sql)).toMatch(/"docKey" = ANY\(\?::text\[\]\)/);
      expect(sql.values).toContainEqual(KEYS);
    }
  });

  it('livePatientWithDoc excluye al propio paciente solo si se pide', () => {
    const own = '00000000-0000-4000-8000-000000000003';
    expect(livePatientWithDocSql(TENANT, 'X1', own).values).toContain(own);
    expect(livePatientWithDocSql(TENANT, 'X1').values).toContain(null);
  });

  it('applyRows bloquea los pacientes existentes en orden de id (sin interbloqueos)', () => {
    expect(flat(patientsToFillByDocSql(TENANT, KEYS))).toMatch(
      /ORDER BY "id" FOR UPDATE$/,
    );
  });

  it('las filas del lote (JSON, sin columna) usan public.dx_doc_key: la misma regla que el trigger', () => {
    const text = flat(knownDocsInFileSql(TENANT, BATCH, KEYS));
    expect(text).toMatch(
      /public\.dx_doc_key\("data"->>'docNumber'\) = ANY\(\?::text\[\]\)/,
    );
    expect(text).not.toMatch(/regexp_replace|upper\(/i);
  });
});
