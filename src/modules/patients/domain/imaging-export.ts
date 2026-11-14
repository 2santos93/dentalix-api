import type { Sex } from '@prisma/client';

/**
 * DX-484: ficha mínima del paciente para darlo de alta en el software de
 * imagen (radiografía digital, cámara intraoral, tomografía). Cada programa
 * pide los mismos cuatro datos con nombres y formatos distintos, así que el
 * fichero los da etiquetados y en las variantes que suelen pedir: apellidos y
 * nombre también sin tildes (muchos solo aceptan ASCII) y la fecha de
 * nacimiento como dd.mm.aaaa y como aaaa-mm-dd.
 *
 * Solo identificación: ni documento, ni contacto, ni ningún dato clínico.
 */
export type ImagingExportPatient = {
  patientCode: string;
  firstName: string;
  lastName: string;
  /** Fecha civil guardada a medianoche UTC (como en toda la ficha). */
  birthDate: Date | null;
  sex: Sex;
};

const MISSING = 'Sin indicar';

const SEX_LABEL: Record<Sex, string> = {
  M: 'M',
  F: 'F',
  OTHER: 'Otro',
  UNSPECIFIED: MISSING,
};

/**
 * Letras que NFD no descompone en base + marca: se escriben con su
 * equivalente latino habitual.
 */
const SPECIAL_LETTERS: Record<string, string> = {
  ß: 'ss',
  æ: 'ae',
  Æ: 'AE',
  ø: 'o',
  Ø: 'O',
  œ: 'oe',
  Œ: 'OE',
  đ: 'd',
  Đ: 'D',
  ł: 'l',
  Ł: 'L',
};
const SPECIAL_LETTERS_RE = new RegExp(
  `[${Object.keys(SPECIAL_LETTERS).join('')}]`,
  'g',
);

/**
 * El texto sin tildes ni diacríticos: «Núñez» → «Nunez», «Müller» → «Muller»,
 * «Ç» → «C». NFD separa la letra de sus marcas y se quitan todas las marcas
 * combinantes (\p{M}); las letras que no se descomponen (ß, æ, ø, œ, đ, ł)
 * van por la tabla. Lo que no es latino se deja como está.
 */
export function withoutDiacritics(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(SPECIAL_LETTERS_RE, (letter) => SPECIAL_LETTERS[letter] ?? letter)
    .normalize('NFC');
}

/**
 * Un valor en una sola línea: un salto de línea o un carácter de control
 * dentro del nombre no puede partir la línea ni inventar otro campo.
 */
function oneLine(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** dd.mm.aaaa y aaaa-mm-dd de una fecha civil (componentes UTC). */
function civilDate(date: Date | null): { dotted: string; iso: string } {
  if (date === null || Number.isNaN(date.getTime())) {
    return { dotted: MISSING, iso: MISSING };
  }
  const y = String(date.getUTCFullYear()).padStart(4, '0');
  const m = pad2(date.getUTCMonth() + 1);
  const d = pad2(date.getUTCDate());
  return { dotted: `${d}.${m}.${y}`, iso: `${y}-${m}-${d}` };
}

/** Nombre del fichero de la descarga: `paciente-<código>.txt`. */
export function imagingExportFileName(patientCode: string): string {
  return `paciente-${patientCode}.txt`;
}

/**
 * El fichero de texto, UTF-8, una línea «Etiqueta: valor» por dato, con fin de
 * línea CRLF (el que esperan los programas de imagen, casi todos de Windows).
 */
export function imagingExportText(patient: ImagingExportPatient): string {
  const lastName = oneLine(patient.lastName);
  const firstName = oneLine(patient.firstName);
  const birth = civilDate(patient.birthDate);
  const lines = [
    `Código del paciente: ${patient.patientCode}`,
    `Apellidos: ${lastName || MISSING}`,
    `Nombre: ${firstName || MISSING}`,
    `Apellidos (sin tildes): ${withoutDiacritics(lastName) || MISSING}`,
    `Nombre (sin tildes): ${withoutDiacritics(firstName) || MISSING}`,
    `Fecha de nacimiento: ${birth.dotted}`,
    `Fecha de nacimiento (aaaa-mm-dd): ${birth.iso}`,
    `Sexo: ${SEX_LABEL[patient.sex]}`,
  ];
  return lines.map((line) => `${line}\r\n`).join('');
}
