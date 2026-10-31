import { createHash } from 'node:crypto';
import type { PrivacyPolicyContent } from './entities/privacy-policy.entity';

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
