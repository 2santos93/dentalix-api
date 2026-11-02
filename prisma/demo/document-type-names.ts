// DX-524: nombre propio de cada sede de la demo para el documento nacional.
// Son DATOS de la demo (la clínica es de varios países y cada sede escribe el
// nombre que usa su gente); el código no conoce ninguno y la clínica no tiene
// nombres propios (DX-327). Londres no tiene: no hay documento nacional, y su
// pantalla cae en el nombre de la clínica y, sin este, en el genérico.
//
// Fichero aparte y sin imports a propósito: la guarda de arquitectura
// (`no-location-fallbacks.spec.ts`) prohíbe nombres de documentos de un país
// en el resto de la demo y de producción, y solo exime a este.
//
// Claves: la de la sede (`DemoLocationKey`) y el tipo de documento
// (`DocumentType`), como texto.
export const DEMO_LOCATION_DOC_TYPE_NAMES: Record<
  string,
  Partial<
    Record<
      'NATIONAL_ID' | 'PASSPORT' | 'RESIDENCE_PERMIT' | 'TAX_ID' | 'OTHER',
      string
    >
  >
> = {
  principal: { NATIONAL_ID: 'Cédula de identidad' },
  norte: { NATIONAL_ID: 'Cédula de identidad' },
  saoPaulo: { NATIONAL_ID: 'CPF' },
};
