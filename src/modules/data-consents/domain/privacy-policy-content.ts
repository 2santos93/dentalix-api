import { createHash } from 'node:crypto';
import type { PrivacyPolicyContent } from './entities/privacy-policy.entity';

/**
 * Los tres elementos que el Dec. 1377 de 2013 (art. 6) exige informar antes de
 * pedir autorización para datos sensibles: que el titular NO está obligado a
 * darla, cuáles de sus datos son sensibles, y para qué se usarán.
 */
export type SensitiveHealthElement =
  'NOT_OBLIGED' | 'SENSITIVE_DATA' | 'PURPOSE';

const REQUIRED_ELEMENTS: {
  element: SensitiveHealthElement;
  pattern: RegExp;
}[] = [
  {
    element: 'NOT_OBLIGED',
    // «no está/estoy obligado(a)» o «no es obligatorio(a)».
    pattern:
      /\bno\s+(esta|estoy|estas)\s+obligad[oa]s?\b|\bno\s+es\s+obligatori[oa]\b/,
  },
  { element: 'SENSITIVE_DATA', pattern: /\bdatos\s+sensibles\b/ },
  { element: 'PURPOSE', pattern: /\bfinalidad(es)?\b/ },
];

export const SENSITIVE_HEALTH_ELEMENT_LABELS: Record<
  SensitiveHealthElement,
  string
> = {
  NOT_OBLIGED: '«no está obligado» a autorizar',
  SENSITIVE_DATA: 'qué «datos sensibles» se tratan',
  PURPOSE: 'la «finalidad» del tratamiento',
};

/** Minúsculas y sin tildes: la comprobación no depende de cómo se teclee. */
function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** Elementos obligatorios que FALTAN en el texto de la casilla SENSITIVE_HEALTH. */
export function missingSensitiveHealthElements(
  text: string,
): SensitiveHealthElement[] {
  const folded = fold(text);
  return REQUIRED_ELEMENTS.filter(({ pattern }) => !pattern.test(folded)).map(
    ({ element }) => element,
  );
}

function normalizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

/** Forma canónica con la que se guarda (y se firma con el hash) el contenido. */
export function normalizePolicyContent(
  content: PrivacyPolicyContent,
): PrivacyPolicyContent {
  return {
    policyText: normalizeText(content.policyText),
    generalText: normalizeText(content.generalText),
    sensitiveHealthText: normalizeText(content.sensitiveHealthText),
    marketingText: normalizeText(content.marketingText),
  };
}

/**
 * sha256 del contenido. Se serializa como array JSON (no concatenado) para que
 * mover texto de un campo a otro cambie el hash.
 */
export function policyContentHash(content: PrivacyPolicyContent): string {
  const canonical = JSON.stringify([
    content.policyText,
    content.generalText,
    content.sensitiveHealthText,
    content.marketingText,
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/** Etiqueta que se escribe en `Patient.dataConsentPolicyVersion` (deprecado). */
export function policyVersionLabel(version: number): string {
  return `v${version}`;
}
