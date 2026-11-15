/**
 * DX-266: datos de la ficha que el modal de fusión compara campo a campo.
 * Cada grupo se elige entero (el documento es tipo + etiqueta + número; la
 * dirección, con su país y ciudad): mezclar el tipo de uno con el número del
 * otro daría un documento que no es de nadie. Lo que no está aquí (canal de
 * avisos, consentimientos, retención, código del paciente) no se elige: lo
 * decide la fusión (ver `dx_merge_patients` y el informe de DX-266).
 */
export const MERGE_FIELD_GROUPS = {
  firstName: ['firstName'],
  lastName: ['lastName'],
  document: ['documentType', 'docTypeLabel', 'docNumber'],
  birthDate: ['birthDate'],
  sex: ['sex'],
  phone: ['phone'],
  email: ['email'],
  address: ['address', 'countryCode', 'cityId'],
  maritalStatus: ['maritalStatus'],
  occupation: ['occupation'],
  physician: ['physicianName', 'physicianPhone'],
  emergencyContact: [
    'emergencyContactName',
    'emergencyContactRelationship',
    'emergencyContactPhone',
  ],
  notes: ['notes'],
  preferredLanguage: ['preferredLanguage'],
} as const satisfies Record<string, readonly string[]>;

export type MergeFieldGroup = keyof typeof MERGE_FIELD_GROUPS;

export const MERGE_FIELD_GROUP_NAMES = Object.keys(
  MERGE_FIELD_GROUPS,
) as MergeFieldGroup[];

export type MergeFieldColumn =
  (typeof MERGE_FIELD_GROUPS)[MergeFieldGroup][number];

/** De qué ficha sale el valor que se queda. Sin elegir: el del conservado. */
export type MergeFieldSource = 'KEPT' | 'ABSORBED';

export const MERGE_FIELD_SOURCES: readonly MergeFieldSource[] = [
  'KEPT',
  'ABSORBED',
];

export type MergeFieldChoices = Partial<
  Record<MergeFieldGroup, MergeFieldSource>
>;

/** Valores de las columnas comparables de una ficha. */
export type MergeFieldValues = Record<MergeFieldColumn, unknown>;

/**
 * Lo que hay que escribir en el conservado: solo los grupos que el ADMIN pidió
 * tomar del absorbido y que de verdad cambian algo. Devuelve también los
 * nombres de esos grupos (para la auditoría: nombres, nunca valores).
 */
export function mergeFieldPatch(
  kept: MergeFieldValues,
  absorbed: MergeFieldValues,
  choices: MergeFieldChoices,
): { patch: Partial<MergeFieldValues>; groups: MergeFieldGroup[] } {
  const patch: Partial<MergeFieldValues> = {};
  const groups: MergeFieldGroup[] = [];
  for (const group of MERGE_FIELD_GROUP_NAMES) {
    if (choices[group] !== 'ABSORBED') continue;
    const columns = MERGE_FIELD_GROUPS[group] as readonly MergeFieldColumn[];
    const differs = columns.some(
      (column) => !sameValue(kept[column], absorbed[column]),
    );
    if (!differs) continue;
    for (const column of columns) patch[column] = absorbed[column];
    groups.push(group);
  }
  return { patch, groups };
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime();
  }
  return (a ?? null) === (b ?? null);
}
