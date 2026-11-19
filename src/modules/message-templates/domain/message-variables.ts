/**
 * DX-565: las variables que puede llevar el texto de un mensaje al paciente.
 * Es una lista CERRADA y es también el tipo del contexto de render
 * (`MessageValues`): un importe, un tratamiento, un diagnóstico o un dato de
 * otro paciente no tienen ni campo donde ir (defensa estructural, no solo de
 * validación). Añadir una variable aquí obliga a darle descripción y ejemplo
 * (`MESSAGE_VARIABLE_INFO`) y la prueba del catálogo la revisa.
 */
export const MESSAGE_VARIABLES = [
  'paciente',
  'clinica',
  'sede',
  'direccion',
  'fecha',
  'hora',
  'profesional',
  'enlace',
  'caduca',
  'cantidad',
] as const;
export type MessageVariable = (typeof MESSAGE_VARIABLES)[number];

/**
 * Lo único que llega al render: texto ya formateado (fecha y hora con el
 * formato y la zona de la sede). Una variable sin valor sale vacía y hace que
 * su tramo opcional («[ con {profesional}]») no salga.
 */
export type MessageValues = { readonly [K in MessageVariable]?: string | null };

export interface MessageVariableInfo {
  /** Qué es, para la clínica (chips del editor). */
  description: string;
  /** Valor de ejemplo de la vista previa: ficticio (Venezuela). */
  sample: string;
}

export const MESSAGE_VARIABLE_INFO: Readonly<
  Record<MessageVariable, MessageVariableInfo>
> = {
  paciente: {
    description:
      'Nombre de pila de quien recibe el mensaje (el paciente o su responsable).',
    sample: 'Ana',
  },
  clinica: {
    description: 'Nombre de la clínica.',
    sample: 'Clínica Dental Altamira',
  },
  sede: {
    description: 'Nombre de la sede de la cita o del hueco.',
    sample: 'Sede Altamira',
  },
  direccion: {
    description: 'Dirección de la sede (puede faltar).',
    sample: 'Av. Francisco de Miranda 93, Caracas',
  },
  fecha: {
    description: 'Día de la cita o del hueco, con el formato de la sede.',
    sample: 'martes 20 de octubre de 2026',
  },
  hora: {
    description: 'Hora de la cita o del hueco, con el reloj de la sede.',
    sample: '9:30 a. m.',
  },
  profesional: {
    description: 'Profesional de la cita o del hueco (puede faltar).',
    sample: 'Dra. Laura Gómez',
  },
  enlace: {
    description: 'Enlace personal del paciente para responder.',
    sample: 'https://ejemplo.dentalix.app/vista-previa',
  },
  caduca: {
    description: 'Cuándo deja de valer el enlace, con el formato de la sede.',
    sample: 'lunes 19 de octubre de 2026 a las 6:00 p. m.',
  },
  cantidad: {
    description: 'Cuántas citas tiene la serie.',
    sample: '4',
  },
};

/**
 * Nombres que alguien podría probar y que NUNCA van en un mensaje al paciente
 * (importes, datos clínicos): se reconocen para decir «no se puede usar» en
 * vez de «no existe». No son variables: no tienen valor en ningún contexto.
 */
export const FORBIDDEN_MESSAGE_VARIABLES: readonly string[] = [
  'importe',
  'monto',
  'saldo',
  'deuda',
  'precio',
  'total',
  'pago',
  'cargo',
  'tratamiento',
  'diagnostico',
  'procedimiento',
  'motivo',
  'nota',
  'notas',
  'medicamento',
  'receta',
];

export function isMessageVariable(name: string): name is MessageVariable {
  return (MESSAGE_VARIABLES as readonly string[]).includes(name);
}
