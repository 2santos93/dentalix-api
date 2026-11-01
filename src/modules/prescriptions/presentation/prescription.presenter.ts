/**
 * Excepción G5.3 (DX-334): recetas emitidas antes de DX-324. El presenter
 * devuelve el `country` legado de una receta anterior a la receta única y, en
 * fase 1, el de la sede en la vista del emisor (spec R12, §4.4). Ninguna regla
 * decide con él.
 */
import type {
  Prescription,
  PrescriptionDocument,
} from '../domain/entities/prescription.entity';
import type { PrescriptionIssuerView } from '../application/use-cases/prescriptions.use-cases';
import type {
  PrescriptionDocumentDto,
  PrescriptionDto,
  PrescriptionIssuerDto,
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
    clinicFiscal: doc.clinicFiscal,
    locationFormat: doc.locationFormat,
    integrityOk: doc.integrityOk,
  };
}

/**
 * Vista del emisor (spec §4.4). En fase 1 abre el bloque de compatibilidad y
 * reenvía el país legado de la sede como `country` (deprecated) para la web
 * anterior a DX-324, que pinta «Sede (país)»; la web nueva no lo lee y la
 * fase 2 lo retira (§10.8).
 */
export function presentIssuer(
  view: PrescriptionIssuerView,
): PrescriptionIssuerDto {
  const { phase1, ...issuer } = view;
  return { ...issuer, country: phase1.country };
}
