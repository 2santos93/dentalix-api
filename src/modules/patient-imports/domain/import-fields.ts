import { DocType } from '@prisma/client';
import type { RegionalFormat } from '../../../shared/format/regional-format';

/**
 * Campos de la ficha que admite la importación de pacientes (DX-107), en el
 * orden de la plantilla. `header` es la cabecera de la plantilla CSV; `label`,
 * el nombre que ven el asistente y el informe de errores; `synonyms`, las
 * cabeceras (ya normalizadas con `headerKey`) que el mapeo automático
 * reconoce en un Excel de otro software.
 *
 * Fuera a propósito: país y ciudad (catálogo con ids), aseguradora (DX-153),
 * acudiente (DX-203), historia clínica, saldo (DX-262) y citas (DX-263).
 */
export const IMPORT_FIELDS = [
  {
    key: 'docType',
    header: 'tipo_documento',
    label: 'Tipo de documento',
    required: false,
    synonyms: [
      'tipodocumento',
      'tipodedocumento',
      'tipodoc',
      'tipoid',
      'tipoidentificacion',
      'tipodeidentificacion',
    ],
  },
  {
    key: 'docNumber',
    header: 'numero_documento',
    label: 'Número de documento',
    required: true,
    synonyms: [
      'numerodocumento',
      'numerodedocumento',
      'nrodocumento',
      'nodocumento',
      'numdocumento',
      'documento',
      'documentoidentidad',
      'numeroidentificacion',
      'numerodeidentificacion',
      'identificacion',
      'cedula',
      'dni',
      'rut',
    ],
  },
  {
    key: 'firstName',
    header: 'nombres',
    label: 'Nombres',
    required: true,
    synonyms: ['nombres', 'nombre', 'primernombre', 'nombrespaciente'],
  },
  {
    key: 'lastName',
    header: 'apellidos',
    label: 'Apellidos',
    required: true,
    synonyms: ['apellidos', 'apellido', 'primerapellido', 'apellidospaciente'],
  },
  {
    key: 'birthDate',
    header: 'fecha_nacimiento',
    label: 'Fecha de nacimiento',
    required: false,
    synonyms: [
      'fechanacimiento',
      'fechadenacimiento',
      'fechanac',
      'fnacimiento',
      'nacimiento',
    ],
  },
  {
    key: 'sex',
    header: 'sexo',
    label: 'Sexo',
    required: false,
    synonyms: ['sexo', 'genero'],
  },
  {
    key: 'phone',
    header: 'telefono',
    label: 'Teléfono',
    required: false,
    synonyms: [
      'telefono',
      'celular',
      'movil',
      'telefonocelular',
      'telefonomovil',
      'whatsapp',
      'tel',
    ],
  },
  {
    key: 'email',
    header: 'email',
    label: 'Correo electrónico',
    required: false,
    synonyms: ['email', 'correo', 'correoelectronico', 'mail', 'emailpaciente'],
  },
  {
    key: 'address',
    header: 'direccion',
    label: 'Dirección',
    required: false,
    synonyms: ['direccion', 'domicilio', 'direcciondomicilio'],
  },
  {
    key: 'occupation',
    header: 'ocupacion',
    label: 'Ocupación',
    required: false,
    synonyms: ['ocupacion', 'profesion'],
  },
  {
    key: 'emergencyContactName',
    header: 'contacto_emergencia',
    label: 'Contacto de emergencia',
    required: false,
    synonyms: [
      'contactoemergencia',
      'contactodeemergencia',
      'nombrecontactoemergencia',
    ],
  },
  {
    key: 'emergencyContactPhone',
    header: 'telefono_emergencia',
    label: 'Teléfono de emergencia',
    required: false,
    synonyms: [
      'telefonoemergencia',
      'telefonodeemergencia',
      'telefonocontactoemergencia',
    ],
  },
  {
    key: 'notes',
    header: 'notas',
    label: 'Notas',
    required: false,
    synonyms: ['notas', 'nota', 'observaciones', 'comentarios'],
  },
] as const;

export type ImportFieldKey = (typeof IMPORT_FIELDS)[number]['key'];

export const IMPORT_FIELD_KEYS: readonly ImportFieldKey[] = IMPORT_FIELDS.map(
  (f) => f.key,
);

export function fieldLabel(key: ImportFieldKey): string {
  return IMPORT_FIELDS.find((f) => f.key === key)?.label ?? key;
}

/** Tope de filas de datos (sin la cabecera) por fichero. */
export const MAX_IMPORT_ROWS = 10_000;
/** Tope del fichero: 5 MB. */
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export const FILE_TOO_LARGE_MESSAGE =
  'El archivo pesa más de 5 MB. Divídelo en varios archivos más pequeños.';
/** Con el número en el formato de la sede del lote (G1-B). */
export const TOO_MANY_ROWS_MESSAGE = (fmt: RegionalFormat) =>
  `El archivo tiene más de ${fmt.number(MAX_IMPORT_ROWS)} filas de pacientes. Divídelo en varios archivos.`;

/** Valores normalizados de una fila válida (lo que se guarda en la ficha). */
export interface ImportPatientData {
  docType: DocType;
  docNumber: string;
  firstName: string;
  lastName: string;
  /** Fecha civil YYYY-MM-DD. */
  birthDate?: string;
  sex?: 'M' | 'F' | 'OTHER';
  phone?: string;
  email?: string;
  address?: string;
  occupation?: string;
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  notes?: string;
}

/**
 * Campos que «Actualizar solo campos vacíos» puede rellenar en un paciente
 * que ya existe. Nunca el nombre ni el documento (son los que lo identifican).
 */
export const FILLABLE_FIELDS = [
  'birthDate',
  'sex',
  'phone',
  'email',
  'address',
  'occupation',
  'emergencyContactName',
  'emergencyContactPhone',
  'notes',
] as const;
export type FillableField = (typeof FILLABLE_FIELDS)[number];

/** Cabecera de un fichero reducida a letras y dígitos, sin tildes. */
export function headerKey(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}
