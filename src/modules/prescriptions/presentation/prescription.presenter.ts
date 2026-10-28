import type {
  Prescription,
  PrescriptionDocument,
} from '../domain/entities/prescription.entity';
import type {
  PrescriptionDocumentDto,
  PrescriptionDto,
} from './dto/prescription.dto';

/**
 * Lo que la API devuelve de una receta (spec §4.6, R5). La fila guarda en
 * fase 1 el país y las letras también en la receta única (réplicas
 * anteriores), pero la respuesta solo los da cuando la receta los usa:
 * - `country`: la plantilla de una receta legada; `null` en la receta única;
 * - `quantityInWords`: la guardada en una legada; en la receta única, solo si
 *   su foto dice que se imprimen.
 * `singleFormat` y `printQuantityInWords` no salen: los dos se leen en esto.
 */
export function presentPrescription(rx: Prescription): PrescriptionDto {
  const { singleFormat, printQuantityInWords, country, items, ...snapshot } =
    rx;
  const showsWords = !singleFormat || printQuantityInWords === true;
  return {
    ...snapshot,
    country: singleFormat ? null : country,
    items: items.map((item) => ({
      ...item,
      quantityInWords: showsWords ? item.quantityInWords : null,
    })),
  };
}

export function presentPrescriptionDocument(
  doc: PrescriptionDocument,
): PrescriptionDocumentDto {
  return {
    ...presentPrescription(doc),
    clinicLogoUrl: doc.clinicLogoUrl,
    locationFormat: doc.locationFormat,
    integrityOk: doc.integrityOk,
  };
}
