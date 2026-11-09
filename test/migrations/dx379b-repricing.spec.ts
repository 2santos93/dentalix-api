import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// DX-379 (porción B): la tabla de recotizaciones y la excepción de los dos
// triggers de la foto del precio. NO es solo aditiva: reemplaza dos funciones
// (con su vuelta atrás escrita en la cabecera). Los triggers solo admiten el
// cambio con la marca de la transacción y en un plan abierto (int:
// test/plan-repricing.int-spec.ts).

const DIR = join(__dirname, '../../prisma/migrations');
const NAME = '20261205090000_dx379b_plan_repricings';
const raw = readFileSync(join(DIR, NAME, 'migration.sql'), 'utf8');
const code = raw.replace(/--[^\n]*/g, '').trim();

describe('DX-379 (B): migración de la recotización', () => {
  it('fija lock_timeout antes de la primera sentencia', () => {
    expect(code).toMatch(/^SET LOCAL lock_timeout = '5s';/);
  });

  it('no borra, renombra, rellena ni cambia columnas existentes', () => {
    expect(code).not.toMatch(
      /\bDROP\b|\bRENAME\b|ALTER\s+COLUMN|^\s*UPDATE\b|DELETE\s+FROM|TRUNCATE\s+"|DISABLE\s+TRIGGER|SECURITY\s+DEFINER|BYPASSRLS/im,
    );
  });

  it('la tabla nueva: RLS FORCE, solo SELECT/INSERT para la app y trigger de solo alta', () => {
    expect(code).toContain(
      'ALTER TABLE "treatment_plan_repricings" FORCE ROW LEVEL SECURITY;',
    );
    expect(code).toContain(
      'GRANT SELECT, INSERT ON "treatment_plan_repricings" TO dentalix_app;',
    );
    expect(code).toContain(
      'REVOKE UPDATE, DELETE, TRUNCATE ON "treatment_plan_repricings" FROM dentalix_app;',
    );
    expect(code).toContain(
      'CREATE TRIGGER "treatment_plan_repricings_append_only"',
    );
  });

  it('las dos funciones reemplazadas solo ceden con la marca y en un plan abierto', () => {
    for (const fn of [
      'treatment_plan_items_catalog_currency_frozen',
      'treatment_plan_items_reference_frozen',
    ]) {
      const body = code.slice(
        code.indexOf(`CREATE OR REPLACE FUNCTION public."${fn}"()`),
      );
      expect(body.length).toBeLessThan(code.length);
      expect(body.slice(0, body.indexOf('$$;'))).toContain(
        'public."treatment_plan_item_reprice_allowed"(OLD."planId", OLD."status"::text)',
      );
    }
    const allowed = code.slice(
      code.indexOf(
        'CREATE FUNCTION public."treatment_plan_item_reprice_allowed"',
      ),
    );
    expect(allowed).toMatch(
      /current_setting\('app\.plan_item_reprice', true\)/,
    );
    expect(allowed).toMatch(/IN \('DRAFT', 'PRESENTED'\)/);
    expect(allowed).toContain('treatment_plan_acceptances');
    expect(allowed).toContain("item_status = 'PROPOSED'");
  });

  it('documenta que no es solo aditiva y su vuelta atrás', () => {
    expect(raw).toContain('NO ES SOLO ADITIVA');
    expect(raw).toContain('Vuelta atrás');
  });

  it('va después de la última migración de la porción A', () => {
    const all = readdirSync(DIR)
      .filter((d) => /^\d{14}_/.test(d))
      .sort();
    expect(all.indexOf(NAME)).toBeGreaterThan(
      all.indexOf('20261204090100_dx379_quote_validity_validate'),
    );
  });
});
