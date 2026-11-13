import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ts from 'typescript';

/**
 * DX-497, criterio 7: ningún texto del recordatorio de cita para el paciente
 * queda como literal fuera del catálogo por idioma. La plantilla y el
 * esqueleto que usa solo pueden llevar literales técnicos (tipos de bloque,
 * nombre del producto); todo lo demás sale de
 * `catalog/appointment-reminder.catalog.ts`.
 */
const TEMPLATE = join(__dirname, 'appointment-reminder.template.ts');

/** Literales con letras que la plantilla puede llevar (no son copy). */
const ALLOWED = new Set(['paragraph', 'note', 'Dentalix']);

function textLiterals(file: string): string[] {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    // Rutas de los import: no son texto.
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const text = node.text.trim();
      if (/\p{L}/u.test(text) && !ALLOWED.has(text)) found.push(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('DX-497: el recordatorio de cita no lleva copy fuera del catálogo', () => {
  it('appointment-reminder.template.ts no tiene literales para el paciente', () => {
    expect(textLiterals(TEMPLATE)).toEqual([]);
  });

  it('la prueba detecta un literal (control)', () => {
    const tmp = join(__dirname, 'catalog', 'appointment-reminder.catalog.ts');
    expect(textLiterals(tmp).length).toBeGreaterThan(10);
  });
});
