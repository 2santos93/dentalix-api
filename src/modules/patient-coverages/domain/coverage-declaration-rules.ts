/**
 * SEC-049/SEC-053: cuándo una edición «redeclara» la cobertura, es decir,
 * borra la verificación del ADMIN y deja como declarante a quien la edita.
 * Lo verificado es ESE pagador con ESE nº de afiliado y ESA vigencia:
 * - cambiar el pagador o el nº la redeclara siempre, la edite quien la edite;
 * - cambiar la vigencia (`validFrom`/`validTo`) de una cobertura de pagador
 *   externo la redeclara si quien edita no es ADMIN (BE-048: recepción
 *   alargaba o quitaba el fin de una cobertura verificada y vencida y se
 *   asignaba el convenio del 100 %). Un ADMIN puede corregir la vigencia sin
 *   perder la verificación: es él quien verifica.
 * Notas, plan, titular o principal no la tocan.
 *
 * La decide el repositorio con el candado del paciente tomado, sobre lo
 * guardado en ese momento: no hay carrera entre leer «verificada» y escribir.
 */
import { ClinicRole } from '@prisma/client';
import { memberNumberChanged } from './member-number-rules';

/** Vigencia de una cobertura: días civiles `YYYY-MM-DD` o `null` (abierta). */
export interface CoverageValidity {
  validFrom: string | null;
  validTo: string | null;
}

/** Lo guardado que mira la regla, leído con el candado tomado. */
export interface CoverageDeclarationFacts extends CoverageValidity {
  payerId: string;
  memberNumber: string | null;
  /** ¿El pagador guardado es externo (SEC-047)? OTHER no se verifica. */
  externalPayer: boolean;
}

/** Lo que trae la edición; `undefined` = no se toca. */
export interface CoverageDeclarationPatch {
  payerId?: string;
  memberNumber?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
}

/** ¿La edición cambia de verdad la vigencia guardada? Enviar lo mismo no cuenta. */
export function coverageValidityChanged(
  live: CoverageValidity,
  patch: CoverageDeclarationPatch,
): boolean {
  return (
    (patch.validFrom !== undefined && patch.validFrom !== live.validFrom) ||
    (patch.validTo !== undefined && patch.validTo !== live.validTo)
  );
}

/** ¿Esta edición, hecha por `editorRole`, redeclara la cobertura? */
export function coverageRedeclared(
  live: CoverageDeclarationFacts,
  patch: CoverageDeclarationPatch,
  editorRole: ClinicRole,
): boolean {
  if (patch.payerId !== undefined && patch.payerId !== live.payerId) {
    return true;
  }
  if (
    patch.memberNumber !== undefined &&
    memberNumberChanged(live.memberNumber, patch.memberNumber)
  ) {
    return true;
  }
  return (
    editorRole !== ClinicRole.ADMIN &&
    live.externalPayer &&
    coverageValidityChanged(live, patch)
  );
}
