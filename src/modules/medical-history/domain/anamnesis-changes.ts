import { changedFields } from '../../audit/domain/changed-fields';
import type { MedicalHistory } from './entities/medical-history.entity';
import type { MedicalHistoryInput } from './anamnesis-answers';

/** Lo que responde una anamnesis, campo a campo, con el nombre del DTO. */
function answers(version: MedicalHistory | null): Record<string, unknown> {
  return {
    allergies: version?.allergies ?? [],
    conditions: version?.conditions ?? [],
    medications: version?.medications ?? [],
    habits: version?.habits ?? null,
    pregnancy: version?.pregnancy ?? null,
    semanasEmbarazo: version?.safetyFlags.semanasEmbarazo ?? null,
    dentalHistory: version?.dentalHistory ?? null,
    surgeries: version?.surgeries ?? [],
    vitalSigns: version?.vitalSigns ?? null,
    familyHistory: version?.familyHistory ?? null,
    notes: version?.notes ?? null,
  };
}

/**
 * DX-095: los campos de la anamnesis que cambió un guardado. Cada guardado
 * añade una versión con el formulario entero, así que lo enviado no dice qué
 * se editó: se compara la versión nueva con la anterior (la primera, con una
 * anamnesis vacía). Solo los campos que se enviaron (`embarazo`, de un
 * cliente anterior, cuenta como `pregnancy`) y que son respuestas. Solo
 * nombres, nunca valores.
 */
export function anamnesisChangedFields(
  previous: MedicalHistory | null,
  saved: MedicalHistory,
  sent: MedicalHistoryInput,
): string[] {
  const before = answers(previous);
  const fields = Object.entries(sent)
    .filter(([, value]) => value !== undefined)
    .map(([field]) => (field === 'embarazo' ? 'pregnancy' : field))
    // Lo que no es una respuesta (un `tenantId` colado) no se guarda.
    .filter((field) => field in before);
  return changedFields(before, answers(saved), fields);
}
