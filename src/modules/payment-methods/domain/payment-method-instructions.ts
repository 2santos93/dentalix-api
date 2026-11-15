/**
 * DX-569: los datos para pagar de un medio (lo que hoy recepción manda a mano
 * por WhatsApp). Campos estructurados, neutros y opcionales para que el
 * paciente copie cada uno: ninguno nombra un banco ni un documento de un país.
 * De toda la clínica (`locationId` null) o de una sede, que gana a la de la
 * clínica.
 */

export const PAYMENT_INSTRUCTION_FIELDS = [
  'holderName',
  'holderId',
  'bankName',
  'accountNumber',
  'phone',
  'email',
  'note',
] as const;

export type PaymentInstructionField =
  (typeof PAYMENT_INSTRUCTION_FIELDS)[number];

/** Tope de caracteres de cada campo (el mismo CHECK en la BD). */
export const PAYMENT_INSTRUCTION_LIMITS: Readonly<
  Record<PaymentInstructionField, number>
> = {
  holderName: 80,
  holderId: 30,
  bankName: 80,
  accountNumber: 40,
  phone: 20,
  email: 120,
  note: 280,
};

/** Etiquetas neutras de cada campo, para los mensajes de error. */
const FIELD_LABELS: Readonly<Record<PaymentInstructionField, string>> = {
  holderName: 'El titular',
  holderId: 'La identificación del titular',
  bankName: 'El banco o entidad',
  accountNumber: 'El número de cuenta',
  phone: 'El teléfono',
  email: 'El correo',
  note: 'La nota',
};

export type PaymentInstructionFields = Record<
  PaymentInstructionField,
  string | null
>;

export const PAYMENT_INSTRUCTIONS_EMPTY_MESSAGE =
  'Escribe al menos un dato para pagar (titular, banco, cuenta, teléfono, correo o una nota).';
export const PAYMENT_INSTRUCTIONS_NOT_FOUND_MESSAGE =
  'No encontramos esos datos para pagar en este medio.';
export const PAYMENT_INSTRUCTIONS_LOCATION_NOT_FOUND_MESSAGE =
  'La sede no existe en esta clínica.';
export const PAYMENT_INSTRUCTIONS_ADMIN_MESSAGE =
  'Solo un administrador puede cambiar los datos para pagar de un medio.';

function tooLongMessage(field: PaymentInstructionField): string {
  return `${FIELD_LABELS[field]} admite hasta ${PAYMENT_INSTRUCTION_LIMITS[field]} caracteres.`;
}

function lineBreakMessage(field: PaymentInstructionField): string {
  return `${FIELD_LABELS[field]} va en una sola línea.`;
}

/** Saltos de línea y caracteres de control (la nota admite saltos de línea). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const LINE_BREAK = /[\r\n]/;

export type InstructionsParse =
  | { ok: true; fields: PaymentInstructionFields }
  | { ok: false; message: string };

/**
 * Normaliza lo que llega del cliente: recorta, un campo en blanco (o ausente)
 * es `null`, cada uno con su tope y en una línea (salvo la nota) y al menos
 * uno con texto.
 */
export function parsePaymentInstructions(
  input: Partial<Record<PaymentInstructionField, string | null | undefined>>,
): InstructionsParse {
  const fields = {} as PaymentInstructionFields;
  for (const field of PAYMENT_INSTRUCTION_FIELDS) {
    const raw = input[field];
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (value === '') {
      fields[field] = null;
      continue;
    }
    if (value.length > PAYMENT_INSTRUCTION_LIMITS[field]) {
      return { ok: false, message: tooLongMessage(field) };
    }
    if (CONTROL.test(value) || (field !== 'note' && LINE_BREAK.test(value))) {
      return { ok: false, message: lineBreakMessage(field) };
    }
    fields[field] = value;
  }
  if (PAYMENT_INSTRUCTION_FIELDS.every((f) => fields[f] === null)) {
    return { ok: false, message: PAYMENT_INSTRUCTIONS_EMPTY_MESSAGE };
  }
  return { ok: true, fields };
}

/** Una fila de datos para pagar (de la clínica o de una sede). */
export interface PaymentMethodInstruction extends PaymentInstructionFields {
  id: string;
  paymentMethodId: string;
  /** `null` = toda la clínica. */
  locationId: string | null;
  updatedAt: Date;
}

/**
 * Los datos que rigen para un medio en una sede: los de la sede si los tiene;
 * si no, los de toda la clínica; `null` si no hay ninguno.
 */
export function instructionsFor<
  T extends { paymentMethodId: string; locationId: string | null },
>(rows: readonly T[], paymentMethodId: string, locationId: string): T | null {
  const own = rows.filter((r) => r.paymentMethodId === paymentMethodId);
  return (
    own.find((r) => r.locationId === locationId) ??
    own.find((r) => r.locationId === null) ??
    null
  );
}

/** Lo que el enlace de pago necesita saber de un medio. */
export interface LinkPaymentMethodCandidate {
  id: string;
  name: string;
  active: boolean;
  allowInPaymentLink: boolean;
}

/**
 * Los medios que el enlace ofrece en una sede (D1): activos, con «Permitir en
 * el enlace de pago» y con datos para pagar en esa sede (o de la clínica).
 * Cada uno con los datos que rigen. Por nombre, como el selector del abono.
 */
export function offeredPaymentMethods<
  M extends LinkPaymentMethodCandidate,
  I extends { paymentMethodId: string; locationId: string | null },
>(
  methods: readonly M[],
  instructions: readonly I[],
  locationId: string,
): { method: M; instructions: I }[] {
  return methods
    .filter((m) => m.active && m.allowInPaymentLink)
    .map((method) => ({
      method,
      instructions: instructionsFor(instructions, method.id, locationId),
    }))
    .filter((o): o is { method: M; instructions: I } => o.instructions !== null)
    .sort((a, b) => a.method.name.localeCompare(b.method.name, 'es'));
}
