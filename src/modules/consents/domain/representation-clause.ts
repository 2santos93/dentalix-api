import type { ResponsibleRelationship } from '@prisma/client';

/** Cómo se nombra cada relación en el texto («como su madre»). */
const RELATIONSHIP_NOUNS: Record<ResponsibleRelationship, string> = {
  MOTHER: 'madre',
  FATHER: 'padre',
  LEGAL_GUARDIAN: 'tutor legal',
  GRANDPARENT: 'abuelo/a',
  SIBLING: 'hermano/a',
  SPOUSE: 'cónyuge o pareja',
  CHILD: 'hijo/a',
  OTHER: 'representante',
};

export interface RepresentationClauseInput {
  representativeName: string;
  representativeDocument: string;
  /** Sin ella (cliente antiguo), «representante». */
  relationship?: ResponsibleRelationship;
  patientName: string;
}

/**
 * DX-060 (m-3): cuando firma un tutor o representante, el documento abre con
 * este párrafo. Identifica a quien firma y su relación con el paciente, y deja
 * claro que lo dicho en primera persona («Yo, …») lo declara en nombre del
 * paciente. No cita ninguna ley: la plantilla de la clínica es la que adapta
 * el texto a su marco legal. Va dentro del cuerpo sellado (el hash lo cubre).
 */
export function representationClause(input: RepresentationClauseInput): string {
  const { representativeName: name, patientName: patient } = input;
  const noun = RELATIONSHIP_NOUNS[input.relationship ?? 'OTHER'];
  return (
    `Firma en representación del paciente: ${name}, identificado(a) con ${input.representativeDocument}, ` +
    `otorga este consentimiento en nombre de ${patient}, como su ${noun}. Lo que este documento ` +
    `dice en primera persona lo declara ${name} en representación de ${patient}.`
  );
}
