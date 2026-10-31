import {
  ClinicRole,
  DentitionEventReason,
  DentitionType,
  DiscountReason,
  DocumentType,
  InventoryMovementType,
  PaymentMethod,
  Sex,
  ToothRecordOrigin,
  ToothRecordStatus,
  ToothSurface,
  TreatmentPlanItemStatus,
  TreatmentPlanStatus,
  CollectionChannel,
  CollectionOutcome,
} from '@prisma/client';
import type { MedicalHistoryVersionData } from '../../src/modules/medical-history/domain/ports/medical-history-repository.port';
import type { ScheduleRange } from '../../src/modules/location-schedule/application/business-hours';
import type { DemoLocationKey } from './calendar';
import {
  ANAMNESIS_CONDITIONS,
  type AnamnesisAnswers,
} from '../../src/modules/medical-history-submissions/domain/anamnesis-questionnaire';

// Datos FICTICIOS de la clínica demo: una clínica venezolana que trabaja en
// USD (el país, la zona, el formato y los nombres locales de los documentos
// son DATOS de la clínica; el código no sabe de Venezuela). Nombres,
// direcciones y documentos inventados, sin leyes ni aseguradoras reales. Los
// correos usan example.com (RFC 2606). Los teléfonos son venezolanos con el
// abonado 555-01XX/02XX/03XX: Venezuela no reserva un tramo para ficción, así
// que se usa el bloque «555» que se reconoce como ficticio; son válidos para
// libphonenumber (los 04XX, tipo MOBILE) y la app nunca escribe a un teléfono
// sola (WhatsApp es un enlace `wa.me` que abre una persona).

export const DEMO_SUBDOMAIN = 'demo';
export const DEMO_CLINIC_NAME = 'Clínica Demo';
export const DEMO_PRIMARY_COLOR = '#0E7C86';
export const DEMO_EMAIL_DOMAIN = 'demo.dentalix.app';
/** Contraseña común de todos los usuarios demo (se imprime al terminar). */
export const DEMO_PASSWORD = 'DemoDentalix2026!';
/**
 * Configuración regional de las sedes demo (DATOS: la API exige país, moneda,
 * zona y formato explícitos, sin valores por defecto). La demo es una clínica
 * venezolana que trabaja en USD, como la mayoría de las de su primer mercado:
 *  - país VE en las dos sedes;
 *  - moneda USD en las dos (planes, listas de precios, caja, gastos). La
 *    multimoneda se ve como en Venezuela: parte de los abonos se cobra en
 *    bolívares (VES) con la tasa manual del día que registra la clínica
 *    (`DEMO_RATE_CURRENCY`, `demoVesPerUsd`), y la caja abierta tiene fondo
 *    en las dos monedas;
 *  - zona America/Caracas: UTC−4 fijo, sin horario de verano desde 2016, así
 *    que el calendario demo pasa de hora de pared a instante con un desfase
 *    constante (ver `calendar.ts`);
 *  - formato `es-VE` (12.345,67 · 31/10/2026).
 */
export const DEMO_COUNTRY = 'VE';
/** Moneda de la clínica y de sus dos sedes: planes y abonos van en USD. */
export const DEMO_CURRENCY = 'USD';
export const DEMO_LOCALE = 'es-VE';
/**
 * La otra moneda de la demo: los bolívares de los abonos por «Pago móvil» o
 * en efectivo en Bs. Su tasa es MANUAL (la que la clínica registra cada día,
 * DX-374), desde `DEMO_MANUAL_RATE_DAYS` días atrás.
 */
export const DEMO_RATE_CURRENCY = 'VES';
/** Días de tasas manuales sembradas (hoy incluido): cubren toda la historia de abonos. */
export const DEMO_MANUAL_RATE_DAYS = 61;
/**
 * Tasa FICTICIA de la demo (VES por 1 USD) del día `daysAgo`: 250,00 hoy y
 * ayer, y 0,50 menos por cada día anterior (220,50 hace 60 días, la más antigua). Hoy y ayer
 * valen lo mismo para que el abono en bolívares «de hace 30 min» dé la misma
 * cifra en USD aunque la siembra cruce la medianoche de la sede (DX-449).
 */
export function demoVesPerUsd(daysAgo: number): number {
  return 250 - 0.5 * Math.max(0, daysAgo - 1);
}
/** El importe en VES que vale `usd` con la tasa demo del día `daysAgo`. */
export function demoVes(usd: number, daysAgo: number): number {
  return Math.round(usd * demoVesPerUsd(daysAgo) * 100) / 100;
}
/**
 * DX-327 / V1: nombre local del documento nacional, como lo llaman las
 * clínicas venezolanas: dato de la clínica, puesto por el caso de uso de
 * Ajustes (lo haría su ADMIN) y editable. Los demás tipos se quedan con el
 * nombre genérico. Es la ÚNICA línea de la demo con un nombre de documento de
 * un país: excepción nombrada de `no-location-fallbacks.spec.ts`.
 */
export const DEMO_DOCUMENT_TYPE_NAMES = {
  NATIONAL_ID: 'Cédula de identidad',
  PASSPORT: null,
  RESIDENCE_PERMIT: null,
  TAX_ID: null,
  OTHER: null,
} as const;
/**
 * G1-B (DX-350): reloj de las sedes demo, explícito (nunca un default): 24 h,
 * el que la demo pinta hoy en pantalla (spec G1-B §4.5).
 */
export const DEMO_HOUR_CYCLE = 'h23';

interface DemoUser {
  email: string;
  fullName: string;
  role: ClinicRole;
  /**
   * DX-089: sedes en las que atiende. Sin el campo atiende en todas (lo
   * normal); con él, el seed lo restringe con el mismo caso de uso que
   * `PUT /staff/:userId/locations`.
   */
  locations?: readonly DemoLocationKey[];
}

/** El primero es el dueño (lo crea el registro); el resto entra por invitación. */
export const DEMO_USERS: readonly DemoUser[] = [
  {
    email: `admin@${DEMO_EMAIL_DOMAIN}`,
    fullName: 'Marcela Rojas Salazar',
    role: ClinicRole.ADMIN,
  },
  {
    email: `dentista@${DEMO_EMAIL_DOMAIN}`,
    fullName: 'Andrés Gómez Pérez',
    role: ClinicRole.DENTIST,
  },
  {
    email: `dentista2@${DEMO_EMAIL_DOMAIN}`,
    fullName: 'Valentina Restrepo Mejía',
    role: ClinicRole.DENTIST,
  },
  {
    email: `recepcion@${DEMO_EMAIL_DOMAIN}`,
    fullName: 'Paola Martínez Ruiz',
    role: ClinicRole.RECEPTION,
  },
  {
    email: `asistente@${DEMO_EMAIL_DOMAIN}`,
    fullName: 'Camilo Herrera Duarte',
    role: ClinicRole.ASSISTANT,
  },
  // DX-089: «Recepción Norte», restringida a la Sede Norte. Va la última para
  // no mover los índices del resto (dentistas, recepción y asistente).
  {
    email: `recepcion.norte@${DEMO_EMAIL_DOMAIN}`,
    fullName: 'Lorena Ospina Vargas',
    role: ClinicRole.RECEPTION,
    locations: ['norte'],
  },
];

export const DEMO_LOCATIONS: Record<
  DemoLocationKey,
  { name: string; address: string }
> = {
  // La crea el registro con el nombre "Sede principal"; el seed le pone dirección.
  principal: {
    name: 'Sede principal',
    address: 'Av. Principal, Edif. Torre Demo, piso 3, consultorio 302',
  },
  norte: {
    name: 'Sede Norte',
    address: 'Calle Los Mangos, C.C. Demo Norte, local 4',
  },
};

/** Horario propio de la Sede Norte (la principal conserva el del registro). */
export const NORTE_SCHEDULE: ScheduleRange[] = [
  ...[1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, startMinute: 7 * 60, endMinute: 12 * 60 },
    { weekday, startMinute: 13 * 60, endMinute: 17 * 60 },
  ]),
  { weekday: 6, startMinute: 8 * 60, endMinute: 12 * 60 },
];

/**
 * DX-222: teléfono de la sede principal, el que las indicaciones
 * postoperatorias muestran para urgencias (`{{telefono_sede}}`). Ficticio.
 */
export const DEMO_PRINCIPAL_PHONE = '+58 212 555 0100';

/** Tarifas (USD) que la clínica demo pone a los ítems del catálogo por defecto. */
export const DEMO_PRICES: Record<string, number> = {
  'IMG-CONSULTA': 80,
  'IMG-RX-PERIAPICAL': 35,
  'IMG-RX-PANORAMICA': 90,
  'PREV-PROFILAXIS': 120,
  'PREV-FLUOR': 50,
  'PREV-SELLANTE': 70,
  'OP-RESINA-1': 150,
  'OP-RESINA-2': 190,
  'OP-RESINA-3': 230,
  'ENDO-UNI': 450,
  'ENDO-MULTI': 750,
  'PERIO-RASPADO': 180,
  'CX-EXO-SIMPLE': 150,
  'CX-CORDAL-INCL': 450,
  'PROT-CORONA-PROV': 250,
  'PROT-CORONA-LM': 1200,
  // DX-040: la opción B (puente fijo de 3 unidades) del grupo A/B de la demo.
  'PROT-PUENTE': 1150,
  'IMPL-IMPLANTE': 3500,
  'IMPL-CORONA': 1800,
  'ORTO-VALORACION': 100,
  'ORTO-CONTROL': 120,
  'PED-SELLANTE': 65,
  'PED-FLUOR': 45,
  'EST-BLANQ-CONSULTORIO': 650,
  'EST-CARILLA-RESINA': 380,
  'URG-CONSULTA': 90,
};

interface DemoPatient {
  firstName: string;
  lastName: string;
  docType: DocumentType;
  docNumber: string;
  birthDate: string; // YYYY-MM-DD
  sex: Sex;
  phone: string;
  email: string;
  address: string;
  occupation?: string;
  maritalStatus?: string;
  emergencyContactName?: string;
  emergencyContactRelationship?: string;
  emergencyContactPhone?: string;
  medicalHistory?: MedicalHistoryVersionData;
}

const healthy: MedicalHistoryVersionData = {
  allergies: [],
  conditions: [],
  medications: [],
  habits: {
    tabaquismo: { activo: false },
    higieneOral: { cepilladoPorDia: 3, hilo: true, cremaConFluor: true },
  },
};

export const DEMO_PATIENTS: readonly DemoPatient[] = [
  {
    firstName: 'Laura',
    lastName: 'Castro Jiménez',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0001',
    birthDate: '1992-03-14',
    sex: Sex.F,
    phone: '+58 414 555 0101',
    email: 'laura.castro@example.com',
    address: 'Calle Los Almendros 127, Apto 501',
    occupation: 'Diseñadora gráfica',
    maritalStatus: 'Soltera',
    emergencyContactName: 'Rosa Jiménez',
    emergencyContactRelationship: 'Madre',
    emergencyContactPhone: '+58 424 555 0201',
    medicalHistory: {
      ...healthy,
      habits: {
        tabaquismo: { activo: true, porDia: 5, anios: 8 },
        higieneOral: { cepilladoPorDia: 2, hilo: false },
      },
      dentalHistory: {
        motivoConsulta: 'Sensibilidad al frío en molares inferiores',
        sensibilidad: true,
        ultimaVisita: 'Hace 2 años',
      },
    },
  },
  {
    firstName: 'Jorge Eduardo',
    lastName: 'Ramírez Ospina',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0002',
    birthDate: '1968-11-02',
    sex: Sex.M,
    phone: '+58 424 555 0102',
    email: 'jorge.ramirez@example.com',
    address: 'Av. Las Palmas 853',
    occupation: 'Contador',
    maritalStatus: 'Casado',
    emergencyContactName: 'Gloria Ospina',
    emergencyContactRelationship: 'Esposa',
    emergencyContactPhone: '+58 424 555 0202',
    medicalHistory: {
      allergies: [],
      conditions: [
        {
          codigo: 'HIPERTENSION',
          etiqueta: 'Hipertensión',
          estado: 'SI',
          esAlerta: true,
          nota: 'Controlada',
        },
        // DX-247: necesita profilaxis antibiótica → «Requiere premedicación».
        {
          codigo: 'PROTESIS_VALVULAR',
          etiqueta: 'Prótesis valvular',
          estado: 'SI',
          esAlerta: true,
          nota: 'Válvula aórtica mecánica (2018)',
        },
      ],
      medications: [
        {
          nombre: 'Losartán',
          dosis: '50 mg',
          frecuencia: 'Cada 24 h',
          motivo: 'Hipertensión',
          esAlerta: false,
        },
      ],
      vitalSigns: { sistolica: 135, diastolica: 85, fc: 72 },
      dentalHistory: {
        motivoConsulta: 'Rehabilitar molar inferior perdido',
        tratamientosPrevios: ['Exodoncia 36 (2019)'],
      },
    },
  },
  {
    firstName: 'Natalia',
    lastName: 'Vargas Quintero',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0003',
    birthDate: '1998-07-21',
    sex: Sex.F,
    phone: '+58 416 555 0103',
    email: 'natalia.vargas@example.com',
    address: 'Calle Los Robles 53',
    occupation: 'Estudiante de medicina',
    medicalHistory: healthy,
  },
  {
    firstName: 'Héctor',
    lastName: 'Molina Cárdenas',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0004',
    birthDate: '1975-01-30',
    sex: Sex.M,
    phone: '+58 426 555 0104',
    email: 'hector.molina@example.com',
    address: 'Av. del Parque 642',
    occupation: 'Conductor',
    medicalHistory: {
      allergies: [],
      conditions: [
        {
          codigo: 'DIABETES',
          etiqueta: 'Diabetes',
          estado: 'SI',
          esAlerta: true,
          nota: 'Tipo 2',
        },
      ],
      medications: [
        {
          nombre: 'Metformina',
          dosis: '850 mg',
          frecuencia: 'Cada 12 h',
          motivo: 'Diabetes tipo 2',
          esAlerta: false,
        },
      ],
      vitalSigns: { glucometria: 142, sistolica: 128, diastolica: 82 },
      dentalHistory: {
        motivoConsulta: 'Dolor intenso en molar inferior derecho',
      },
    },
  },
  {
    firstName: 'Daniela',
    lastName: 'Montoya Arango',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0005',
    birthDate: '1995-09-09',
    sex: Sex.F,
    phone: '+58 412 555 0105',
    email: 'daniela.montoya@example.com',
    address: 'Calle Los Cedros 10',
    occupation: 'Abogada',
  },
  {
    firstName: 'Santiago',
    lastName: 'Pardo Luna',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0006',
    birthDate: '2001-04-18',
    sex: Sex.M,
    phone: '+58 414 555 0106',
    email: 'santiago.pardo@example.com',
    address: 'Av. Libertad 1180',
    occupation: 'Ingeniero de software',
  },
  {
    firstName: 'Martha Lucía',
    lastName: 'Becerra Rincón',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0007',
    birthDate: '1960-12-05',
    sex: Sex.F,
    phone: '+58 424 555 0107',
    email: 'martha.becerra@example.com',
    address: 'Calle Las Acacias 145',
    occupation: 'Pensionada',
    maritalStatus: 'Viuda',
    emergencyContactName: 'Felipe Becerra',
    emergencyContactRelationship: 'Hijo',
    emergencyContactPhone: '+58 424 555 0207',
    medicalHistory: {
      allergies: [
        {
          alergeno: 'Penicilina',
          tipo: 'MEDICAMENTO',
          reaccion: 'Edema de glotis',
          severidad: 'ANAFILAXIA',
          esAlerta: true,
        },
      ],
      conditions: [
        {
          codigo: 'OSTEOPOROSIS',
          etiqueta: 'Osteoporosis / bifosfonatos',
          estado: 'SI',
          esAlerta: true,
        },
      ],
      medications: [
        {
          nombre: 'Alendronato',
          dosis: '70 mg',
          frecuencia: 'Semanal',
          motivo: 'Osteoporosis',
          esAlerta: true,
        },
      ],
      dentalHistory: {
        motivoConsulta: 'Sangrado de encías al cepillarse',
        sangradoEncias: true,
        enfPeriodontal: true,
      },
    },
  },
  {
    firstName: 'Ricardo',
    lastName: 'Salcedo Parra',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0008',
    birthDate: '1955-06-27',
    sex: Sex.M,
    phone: '+58 416 555 0108',
    email: 'ricardo.salcedo@example.com',
    address: 'Pasaje Los Olivos 23',
    occupation: 'Comerciante',
    medicalHistory: {
      allergies: [],
      conditions: [
        {
          codigo: 'CARDIOPATIA',
          etiqueta: 'Enfermedad cardíaca',
          estado: 'SI',
          esAlerta: true,
          nota: 'Fibrilación auricular',
        },
      ],
      medications: [
        {
          nombre: 'Warfarina',
          dosis: '5 mg',
          frecuencia: 'Cada 24 h',
          motivo: 'Fibrilación auricular',
          esAlerta: true,
        },
      ],
      notes: 'Pedir INR reciente antes de procedimientos quirúrgicos.',
    },
  },
  {
    firstName: 'Sofía',
    lastName: 'Ortiz Navarro',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0009',
    birthDate: '2015-02-11',
    sex: Sex.F,
    phone: '+58 426 555 0109',
    email: 'familia.ortiz@example.com',
    address: 'Calle Los Pinos 160',
    emergencyContactName: 'Claudia Navarro',
    emergencyContactRelationship: 'Madre',
    emergencyContactPhone: '+58 424 555 0209',
    medicalHistory: {
      ...healthy,
      habits: { higieneOral: { cepilladoPorDia: 2, cremaConFluor: true } },
      // DX-307: el peso con el que se calcula la dosis máxima de anestésico.
      vitalSigns: { peso: 32 },
    },
  },
  {
    firstName: 'Carolina',
    lastName: 'Duque Henao',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0010',
    birthDate: '1993-10-03',
    sex: Sex.F,
    phone: '+58 412 555 0110',
    email: 'carolina.duque@example.com',
    address: 'Av. del Río 1020',
    occupation: 'Docente',
    medicalHistory: {
      ...healthy,
      embarazo: true,
      semanasEmbarazo: 20,
      notes: 'Embarazo de 20 semanas: evitar radiografías no urgentes.',
    },
  },
  {
    firstName: 'Felipe',
    lastName: 'Arias Londoño',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0011',
    birthDate: '1988-08-16',
    sex: Sex.M,
    phone: '+58 414 555 0111',
    email: 'felipe.arias@example.com',
    address: 'Calle Las Flores 5',
    occupation: 'Chef',
  },
  {
    firstName: 'Juliana',
    lastName: 'Guerrero Pinzón',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0012',
    birthDate: '1990-05-25',
    sex: Sex.F,
    phone: '+58 424 555 0112',
    email: 'juliana.guerrero@example.com',
    address: 'Calle Los Sauces 72',
    occupation: 'Periodista',
    medicalHistory: {
      allergies: [
        {
          alergeno: 'Látex',
          tipo: 'MATERIAL',
          reaccion: 'Urticaria de contacto',
          severidad: 'MODERADA',
          esAlerta: true,
        },
      ],
      conditions: [
        {
          codigo: 'ASMA',
          etiqueta: 'Asma / respiratorio',
          estado: 'SI',
          esAlerta: false,
        },
      ],
      medications: [
        {
          nombre: 'Salbutamol inhalador',
          frecuencia: 'A necesidad',
          motivo: 'Asma',
          esAlerta: false,
        },
      ],
    },
  },
  {
    firstName: 'Mateo',
    lastName: 'Cifuentes Rojas',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0013',
    birthDate: '2012-09-30',
    sex: Sex.M,
    phone: '+58 416 555 0113',
    email: 'familia.cifuentes@example.com',
    address: 'Av. Principal 2415',
  },
  {
    firstName: 'Ana María',
    lastName: 'Zapata Gil',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0014',
    birthDate: '1979-03-08',
    sex: Sex.F,
    phone: '+58 426 555 0114',
    email: 'anamaria.zapata@example.com',
    address: 'Calle Los Laureles 33',
    occupation: 'Administradora de empresas',
    medicalHistory: healthy,
  },
  {
    firstName: 'Luis Fernando',
    lastName: 'Peña Acosta',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0015',
    birthDate: '1970-07-12',
    sex: Sex.M,
    phone: '+58 412 555 0115',
    email: 'luis.pena@example.com',
    address: 'Av. del Mar 728',
    occupation: 'Ingeniero civil',
  },
  {
    firstName: 'Valeria',
    lastName: 'Suárez Medina',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0016',
    birthDate: '2004-12-19',
    sex: Sex.F,
    phone: '+58 414 555 0116',
    email: 'valeria.suarez@example.com',
    address: 'Calle Las Camelias 116',
    occupation: 'Estudiante',
  },
  {
    firstName: 'Gustavo',
    lastName: 'Ríos Villamizar',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0017',
    birthDate: '1966-02-22',
    sex: Sex.M,
    phone: '+58 424 555 0117',
    email: 'gustavo.rios@example.com',
    address: 'Av. Los Jardines 361',
    occupation: 'Agricultor',
    medicalHistory: {
      allergies: [
        {
          alergeno: 'Ibuprofeno',
          tipo: 'MEDICAMENTO',
          reaccion: 'Brote en la piel',
          severidad: 'LEVE',
          esAlerta: false,
        },
      ],
      conditions: [],
      medications: [],
      habits: { tabaquismo: { activo: true, porDia: 10, anios: 30 } },
    },
  },
  {
    firstName: 'Isabella',
    lastName: 'Moreno Castaño',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0018',
    birthDate: '1997-06-06',
    sex: Sex.F,
    phone: '+58 416 555 0118',
    email: 'isabella.moreno@example.com',
    address: 'Calle Los Nogales 63',
    occupation: 'Fotógrafa',
  },
  {
    firstName: 'Alejandro',
    lastName: 'Fuentes Beltrán',
    docType: 'RESIDENCE_PERMIT',
    docNumber: 'DEMO-0019',
    birthDate: '1986-01-17',
    sex: Sex.M,
    phone: '+58 426 555 0119',
    email: 'alejandro.fuentes@example.com',
    address: 'Av. Las Américas 1346',
    occupation: 'Médico veterinario',
  },
  {
    firstName: 'Camila',
    lastName: 'Rincón Pulido',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0020',
    birthDate: '1999-11-28',
    sex: Sex.F,
    phone: '+58 412 555 0120',
    email: 'camila.rincon@example.com',
    address: 'Calle Los Álamos 26',
    occupation: 'Asesora comercial',
  },
  {
    firstName: 'Diego',
    lastName: 'Lozano Torres',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0021',
    birthDate: '1991-04-04',
    sex: Sex.M,
    phone: '+58 414 555 0121',
    email: 'diego.lozano@example.com',
    address: 'Av. Universidad 1345',
    occupation: 'Mecánico',
  },
  {
    firstName: 'Paula Andrea',
    lastName: 'Cortés Silva',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0022',
    birthDate: '1982-08-31',
    sex: Sex.F,
    phone: '+58 424 555 0122',
    email: 'paula.cortes@example.com',
    address: 'Calle Las Magnolias 100',
    occupation: 'Enfermera',
  },
  {
    firstName: 'Tomás',
    lastName: 'Aguilar Reyes',
    docType: 'PASSPORT',
    docNumber: 'DEMO-P01',
    birthDate: '1984-10-10',
    sex: Sex.M,
    phone: '+52 55 5555 0123',
    email: 'tomas.aguilar@example.com',
    address: 'Calle Los Tulipanes 85, Hotel',
    occupation: 'Consultor',
  },
  {
    firstName: 'María José',
    lastName: 'Escobar Franco',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0023',
    birthDate: '1996-01-23',
    sex: Sex.F,
    phone: '+58 426 555 0124',
    email: 'mariajose.escobar@example.com',
    address: 'Av. del Sol 150',
    occupation: 'Arquitecta',
  },
  {
    firstName: 'Sebastián',
    lastName: 'Niño Cabrera',
    docType: 'NATIONAL_ID',
    docNumber: 'DEMO-0024',
    birthDate: '2000-03-15',
    sex: Sex.M,
    phone: '+58 412 555 0125',
    email: 'sebastian.nino@example.com',
    address: 'Calle Los Jazmines 45',
    occupation: 'Músico',
  },
];

/**
 * DX-153: pagadores del catálogo de la clínica demo (reemplazan al texto libre de aseguradora anterior a DX-153).
 *
 * DX-326, fase 1: los tipos son genéricos, pero la tabla `payers` aún guarda
 * los códigos anteriores. `seed-demo.ts` debe crearlos con `CreatePayerUseCase`
 * (que traduce en el repositorio), nunca con `payer.create` directo: el
 * cliente Prisma acepta el genérico y lo guardaría tal cual. Ninguna guarda
 * de arquitectura escanea `prisma/`; lo comprueba
 * `test/seed-demo.int-spec.ts` («demo payers use generic types and no
 * country»), que exige `storedPayerType(type)` en la base.
 */
export const DEMO_PAYERS = [
  { key: 'aseguradora', name: 'Aseguradora Demo', type: 'INSURER' },
  { key: 'prepagada', name: 'Plan Prepagado Demo', type: 'PREPAID_PLAN' },
  { key: 'publico', name: 'Seguro Público Demo', type: 'PUBLIC_SYSTEM' },
  { key: 'horizonte', name: 'Seguros Horizonte Demo', type: 'INSURER' },
  { key: 'mutual', name: 'Mutual Bienestar Demo', type: 'INSURER' },
  { key: 'vital', name: 'Salud Vital Demo', type: 'INSURER' },
  { key: 'premium', name: 'Previsión Premium Demo', type: 'PREPAID_PLAN' },
] as const satisfies readonly {
  key: string;
  name: string;
  type: 'INSURER' | 'PUBLIC_SYSTEM' | 'PREPAID_PLAN';
}[];

/** DX-105: pagador extra de la demo, para el convenio de lista de precios. */
export const DEMO_ALFA_PAYER = {
  name: 'Empresa Alfa',
  type: 'EMPLOYER',
} as const;

/**
 * DX-105: listas de precios. «Tarifa Sede Norte» es la lista activa de la
 * Sede Norte (USD, 5 precios); «Convenio Alfa» es de toda la
 * clínica, en USD, y solo la usa
 * el convenio «Empresa Alfa lista» (3 precios). Los códigos son los de
 * `DEMO_PRICES`, y todos los precios quedan por debajo del de catálogo.
 */
export const DEMO_PRICE_LISTS = [
  {
    key: 'norte',
    name: 'Tarifa Sede Norte',
    locationKey: 'norte',
    currency: DEMO_CURRENCY,
    prices: {
      'IMG-CONSULTA': 75,
      'PREV-PROFILAXIS': 110,
      'OP-RESINA-1': 140,
      'ENDO-UNI': 420,
      'URG-CONSULTA': 85,
    },
  },
  {
    key: 'alfa',
    name: 'Convenio Alfa',
    locationKey: null,
    currency: DEMO_CURRENCY,
    prices: {
      'PREV-PROFILAXIS': 90,
      'OP-RESINA-1': 120,
      'IMG-RX-PERIAPICAL': 28,
    },
  },
] as const;

/** DX-105: los dos convenios de la demo. */
export const DEMO_AGREEMENTS = [
  {
    key: 'aseguradora',
    name: 'Aseguradora Demo −15 %',
    payerName: 'Aseguradora Demo',
    kind: 'PERCENT_DISCOUNT',
    percent: 15,
    priceListKey: null,
  },
  {
    key: 'alfa',
    name: 'Empresa Alfa lista',
    payerName: 'Empresa Alfa',
    kind: 'PRICE_LIST',
    percent: null,
    priceListKey: 'alfa',
  },
] as const;

/**
 * DX-105: tres pacientes con convenio (dos con Aseguradora Demo —que ya tienen su
 * cobertura— y uno con Alfa). SEC-047: el convenio exige una cobertura viva
 * del pagador; `coverage` es la que se le añade si aún no la tiene (la de
 * Alfa, como segunda cobertura, no principal). SEC-049: la registra
 * recepción, así que el ADMIN la verifica antes de que recepción asigne.
 */
export const DEMO_PATIENT_AGREEMENTS = [
  {
    patientIndex: 0,
    agreementKey: 'aseguradora',
    coverage: {
      planName: 'Plan Esencial',
      memberNumber: 'DEMO-ASEG-1000',
    },
  },
  {
    patientIndex: 4,
    agreementKey: 'aseguradora',
    coverage: {
      planName: 'Plan Esencial',
      memberNumber: 'DEMO-ASEG-1004',
    },
  },
  {
    patientIndex: 2,
    agreementKey: 'alfa',
    coverage: {
      planName: 'Plan corporativo Alfa',
      memberNumber: 'DEMO-ALFA-1002',
    },
  },
] as const;

export interface DemoCoverage {
  patientIndex: number;
  payerKey: (typeof DEMO_PAYERS)[number]['key'];
  planName: string;
  memberNumber: string;
  /** YYYY-MM-DD; fechas fijas para que la demo sea estable. */
  validFrom: string | null;
  validTo: string | null;
  isPrimary: boolean;
}

/** Una cobertura principal por paciente que tenía el texto libre de aseguradora anterior a DX-153; una vencida y una pendiente. */
export const DEMO_COVERAGES: readonly DemoCoverage[] = [
  {
    patientIndex: 0,
    payerKey: 'aseguradora',
    planName: 'Plan Esencial',
    memberNumber: 'DEMO-ASEG-1000',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 1,
    payerKey: 'prepagada',
    planName: 'Plan Prepagado Familiar',
    memberNumber: 'DEMO-PREP-1001',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 2,
    payerKey: 'publico',
    planName: 'Cobertura Pública Básica',
    memberNumber: 'DEMO-PUB-1002',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 3,
    payerKey: 'horizonte',
    planName: 'Plan Horizonte Clásico',
    memberNumber: 'DEMO-HORIZ-1003',
    validFrom: null,
    validTo: '2025-12-31',
    isPrimary: true,
  },
  {
    patientIndex: 4,
    payerKey: 'aseguradora',
    planName: 'Plan Esencial',
    memberNumber: 'DEMO-ASEG-1004',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 5,
    payerKey: 'mutual',
    planName: 'Plan Mutual Dental',
    memberNumber: 'DEMO-MUTUAL-1005',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 6,
    payerKey: 'prepagada',
    planName: 'Plan Prepagado Familiar',
    memberNumber: 'DEMO-PREP-1006',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 7,
    payerKey: 'vital',
    planName: 'Plan Vital Integral',
    memberNumber: 'DEMO-VITAL-1007',
    validFrom: '2027-06-01',
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 8,
    payerKey: 'publico',
    planName: 'Cobertura Pública Básica',
    memberNumber: 'DEMO-PUB-1008',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 9,
    payerKey: 'aseguradora',
    planName: 'Plan Esencial',
    memberNumber: 'DEMO-ASEG-1009',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 10,
    payerKey: 'premium',
    planName: 'Plan Premium Oro',
    memberNumber: 'DEMO-PREM-1010',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 11,
    payerKey: 'prepagada',
    planName: 'Plan Prepagado Familiar',
    memberNumber: 'DEMO-PREP-1011',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 12,
    payerKey: 'horizonte',
    planName: 'Plan Horizonte Clásico',
    memberNumber: 'DEMO-HORIZ-1012',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 13,
    payerKey: 'aseguradora',
    planName: 'Plan Esencial',
    memberNumber: 'DEMO-ASEG-1013',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 14,
    payerKey: 'vital',
    planName: 'Plan Vital Integral',
    memberNumber: 'DEMO-VITAL-1014',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 15,
    payerKey: 'publico',
    planName: 'Cobertura Pública Básica',
    memberNumber: 'DEMO-PUB-1015',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 16,
    payerKey: 'horizonte',
    planName: 'Plan Horizonte Clásico',
    memberNumber: 'DEMO-HORIZ-1016',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 17,
    payerKey: 'mutual',
    planName: 'Plan Mutual Dental',
    memberNumber: 'DEMO-MUTUAL-1017',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 19,
    payerKey: 'prepagada',
    planName: 'Plan Prepagado Familiar',
    memberNumber: 'DEMO-PREP-1018',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 20,
    payerKey: 'vital',
    planName: 'Plan Vital Integral',
    memberNumber: 'DEMO-VITAL-1019',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 21,
    payerKey: 'publico',
    planName: 'Cobertura Pública Básica',
    memberNumber: 'DEMO-PUB-1020',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 23,
    payerKey: 'aseguradora',
    planName: 'Plan Esencial',
    memberNumber: 'DEMO-ASEG-1021',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
  {
    patientIndex: 24,
    payerKey: 'mutual',
    planName: 'Plan Mutual Dental',
    memberNumber: 'DEMO-MUTUAL-1022',
    validFrom: null,
    validTo: null,
    isPrimary: true,
  },
];

/**
 * DX-038: adenda de corrección sobre una evolución de DEMO_CLINICAL_ENTRIES
 * (por índice). La evolución original queda intacta; la adenda va debajo.
 */
interface DemoClinicalAddendum {
  entryIndex: number;
  dentistIndex: number;
  reason: string;
  text: string;
}

export const DEMO_CLINICAL_ADDENDA: readonly DemoClinicalAddendum[] = [
  {
    entryIndex: 1,
    dentistIndex: 0,
    reason: 'Error de transcripción en la tensión arterial',
    text: 'La TA al ingreso fue 125/85, no 135/85. El resto de la nota se mantiene.',
  },
];

/**
 * DX-307: anestesia local de ejemplo. La paciente infantil (Sofía, 11 años y
 * 32 kg en la anamnesis) tiene una exodoncia de 75 con 2 carpules de
 * lidocaína 2 % con epinefrina. DX-420: con el máximo pediátrico de la AAPD
 * (4,4 mg/kg) son 72 de 140,8 mg (51 %) y 0,036 mg de epinefrina, sin aviso;
 * al abrirla después, la hoja de sedación del mismo día (DEMO_SEDATION) baja
 * el máximo un 30 % (98,6 mg, 73 %) y lo dice. Por índice de DEMO_PATIENTS.
 */
export const DEMO_ANESTHESIA = {
  patientIndex: 8,
  notes:
    'Exodoncia de 75 por reabsorción radicular incompleta. Hemostasia con gasa; indicaciones a la madre.',
  reason: 'Exodoncia simple',
  sampleCode: 'LIDOCAINE_2_EPI',
  carpules: 2,
  technique: 'NERVE_BLOCK',
  site: '75 (alveolar inferior izquierdo)',
  lot: 'LDC-2610-A',
} as const;

/**
 * DX-407: hoja de sedación consciente completa en una evolución de la misma
 * paciente infantil (restauraciones con óxido nitroso): valoración, checklist,
 * N2O, una toma basal, tres intraoperatorias cada 5 min y egreso firmado por
 * la dentista con la asistente como monitor. Minutos relativos al seed.
 */
export const DEMO_SEDATION = {
  patientIndex: 8,
  reason: 'Restauraciones bajo sedación con óxido nitroso',
  notes:
    'Resinas en 55 y 65 bajo sedación mínima con N2O al 30 %. Colaboradora; sin incidencias.',
  assessment: {
    grade: 'MINIMAL',
    asaClass: 'I',
    asaEmergency: false,
    fastingClearLiquidsHours: 2,
    fastingSolidsHours: 6,
    mallampati: 1,
    weightKg: 32,
    heightCm: 138,
    escortName: 'Claudia Navarro',
    escortRelationship: 'Madre',
    consentConfirmed: true,
  },
  // Horas en orden (QA DX-407): valoración < checklist < toma basal < N2O <
  // tomas intraoperatorias < egreso, todas en el pasado de la siembra.
  assessedMinutesAgo: 60,
  checkedMinutesAgo: 57,
  baselineMinutesAgo: 55,
  n2o: { n2oPercent: 30, flowLpm: 6, minutesAgo: 50 },
  intraMinutesAgo: [45, 40, 35],
  dischargeMinutesAgo: 20,
  vitals: {
    spo2: 98,
    heartRate: 92,
    systolic: 102,
    diastolic: 64,
    respiratoryRate: 20,
  },
} as const;

/**
 * DX-170: evoluciones redactadas con las plantillas de ejemplo y ligadas a las
 * últimas citas atendidas (la más reciente primero). Respuestas por etiqueta;
 * las preguntas sin respuesta toman su valor por defecto.
 */
export const DEMO_TEMPLATE_EVOLUTIONS: readonly {
  template: string;
  answers: Readonly<Record<string, readonly string[]>>;
}[] = [
  {
    template: 'Resina',
    answers: {
      Diente: ['36'],
      Superficie: ['O'],
      Material: ['Resina A2', 'Resina fluida'],
    },
  },
  {
    template: 'Profilaxis',
    answers: {
      Técnica: ['Ultrasonido', 'Pasta profiláctica'],
      Placa: ['Moderada'],
    },
  },
];

interface DemoClinicalEntry {
  patientIndex: number;
  dentistIndex: number;
  daysAgo: number;
  reason: string;
  notes: string;
  /** DX-212: diagnósticos CIE-10 (principal primero). */
  diagnoses?: readonly {
    icd10Code: string;
    kind: 'PRINCIPAL' | 'RELACIONADO';
    toothFdi?: string;
  }[];
}

export const DEMO_CLINICAL_ENTRIES: readonly DemoClinicalEntry[] = [
  {
    patientIndex: 0,
    dentistIndex: 0,
    daysAgo: 40,
    reason: 'Valoración inicial',
    notes:
      'Paciente refiere sensibilidad al frío en 36. Se observa lesión cariosa oclusal. Se indica resina y profilaxis. Se refuerza técnica de cepillado.',
    diagnoses: [
      { icd10Code: 'K02.1', kind: 'PRINCIPAL', toothFdi: '36' },
      { icd10Code: 'K05.1', kind: 'RELACIONADO' },
    ],
  },
  {
    patientIndex: 1,
    dentistIndex: 0,
    daysAgo: 55,
    reason: 'Valoración para implante',
    notes:
      'Ausencia de 36. Rx panorámica con buena altura ósea. Se planea implante + corona. TA 135/85 al ingreso, paciente medicado.',
  },
  {
    patientIndex: 1,
    dentistIndex: 0,
    daysAgo: 30,
    reason: 'Exodoncia de resto radicular',
    notes:
      'Se retira resto radicular en zona de 36 bajo anestesia local (lidocaína 2% con epinefrina, 1 cartucho). Sin complicaciones. Indicaciones post-operatorias por escrito.',
    diagnoses: [{ icd10Code: 'K08.3', kind: 'PRINCIPAL', toothFdi: '36' }],
  },
  {
    patientIndex: 2,
    dentistIndex: 1,
    daysAgo: 42,
    reason: 'Profilaxis y resinas',
    notes:
      'Profilaxis completa. Resina en 16 (O) y 26 (OM). Oclusión verificada con papel articular.',
  },
  {
    patientIndex: 3,
    dentistIndex: 0,
    daysAgo: 26,
    reason: 'Urgencia: dolor en 46',
    notes:
      'Pulpitis irreversible en 46. Glucometría 142 mg/dL. Se realiza apertura cameral y medicación intraconducto.',
    diagnoses: [{ icd10Code: 'K04.0', kind: 'PRINCIPAL', toothFdi: '46' }],
  },
  {
    patientIndex: 3,
    dentistIndex: 0,
    daysAgo: 12,
    reason: 'Endodoncia 46 (obturación)',
    notes:
      'Obturación de conductos de 46 con técnica de condensación lateral. Se coloca provisional. Pendiente corona.',
  },
  {
    patientIndex: 6,
    dentistIndex: 1,
    daysAgo: 18,
    reason: 'Periodoncia: raspaje cuadrantes 1 y 2',
    notes:
      'Raspaje y alisado radicular en cuadrantes 1 y 2. Paciente con alendronato: se evita cirugía periodontal, se trata de forma conservadora. Alérgica a penicilina: no se formula amoxicilina.',
  },
  {
    patientIndex: 7,
    dentistIndex: 0,
    daysAgo: 58,
    reason: 'Urgencia: fractura de 21',
    notes:
      'Fractura coronal complicada de 21. INR 2.4 del día anterior. Se inicia endodoncia, hemostasia local sin novedad.',
  },
  {
    patientIndex: 8,
    dentistIndex: 1,
    daysAgo: 14,
    reason: 'Control odontopediátrico',
    notes:
      'Sellantes en 16 y 26. Buena colaboración. Se cita para aplicación de flúor.',
  },
  {
    patientIndex: 9,
    dentistIndex: 1,
    daysAgo: 9,
    reason: 'Control prenatal odontológico',
    notes:
      'Embarazo de 20 semanas. Gingivitis leve asociada al embarazo. Se refuerza higiene; se difieren radiografías.',
  },
  {
    patientIndex: 10,
    dentistIndex: 0,
    daysAgo: 7,
    reason: 'Resinas en molares',
    notes:
      'Resina en 36 (MOD) y 47 (O). Paciente tolera bien el procedimiento.',
  },
  {
    patientIndex: 11,
    dentistIndex: 1,
    daysAgo: 21,
    reason: 'Valoración',
    notes:
      'Paciente alérgica al látex: se atiende con guantes de nitrilo y dique libre de látex. Fractura incisal en 21.',
  },
  {
    patientIndex: 4,
    dentistIndex: 1,
    daysAgo: 16,
    reason: 'Valoración estética',
    notes:
      'Solicita blanqueamiento y carilla en 21. Se entrega presupuesto (plan en borrador).',
  },
  {
    patientIndex: 5,
    dentistIndex: 0,
    daysAgo: 33,
    reason: 'Valoración de cordales',
    notes:
      'Terceros molares inferiores 38 y 48 retenidos. Se propone cirugía; el paciente decide posponerla.',
  },
];

interface DemoToothRecord {
  patientIndex: number;
  dentistIndex: number;
  daysAgo: number;
  toothNumber: string;
  surfaces: ToothSurface[];
  catalogCode: string;
  status: ToothRecordStatus;
  notes?: string;
}

const { OCCLUSAL, MESIAL, DISTAL, VESTIBULAR } = ToothSurface;

/** Hallazgos registrados directo en el odontograma (los DONE del plan se reflejan solos). */
export const DEMO_TOOTH_RECORDS: readonly DemoToothRecord[] = [
  {
    patientIndex: 0,
    dentistIndex: 0,
    daysAgo: 40,
    toothNumber: '36',
    surfaces: [OCCLUSAL],
    catalogCode: 'DX-CARIES',
    status: ToothRecordStatus.COMPLETED,
  },
  {
    patientIndex: 0,
    dentistIndex: 0,
    daysAgo: 40,
    toothNumber: '25',
    surfaces: [DISTAL],
    catalogCode: 'DX-CARIES-INC',
    status: ToothRecordStatus.COMPLETED,
  },
  {
    patientIndex: 0,
    dentistIndex: 0,
    daysAgo: 40,
    toothNumber: '36',
    surfaces: [OCCLUSAL],
    catalogCode: 'OP-RESINA-1',
    status: ToothRecordStatus.PLANNED,
  },
  {
    patientIndex: 1,
    dentistIndex: 0,
    daysAgo: 55,
    toothNumber: '36',
    surfaces: [],
    catalogCode: 'DX-RESTO-RAD',
    status: ToothRecordStatus.COMPLETED,
  },
  {
    patientIndex: 3,
    dentistIndex: 0,
    daysAgo: 26,
    toothNumber: '46',
    surfaces: [],
    catalogCode: 'DX-PERIAPICAL',
    status: ToothRecordStatus.COMPLETED,
  },
  {
    patientIndex: 5,
    dentistIndex: 0,
    daysAgo: 33,
    toothNumber: '38',
    surfaces: [],
    catalogCode: 'DX-RETENIDO',
    status: ToothRecordStatus.COMPLETED,
  },
  {
    patientIndex: 5,
    dentistIndex: 0,
    daysAgo: 33,
    toothNumber: '48',
    surfaces: [],
    catalogCode: 'DX-RETENIDO',
    status: ToothRecordStatus.COMPLETED,
  },
  {
    patientIndex: 6,
    dentistIndex: 1,
    daysAgo: 18,
    toothNumber: '31',
    surfaces: [VESTIBULAR],
    catalogCode: 'DX-RECESION',
    status: ToothRecordStatus.COMPLETED,
  },
  {
    patientIndex: 11,
    dentistIndex: 1,
    daysAgo: 21,
    toothNumber: '21',
    surfaces: [MESIAL],
    catalogCode: 'DX-FRACT',
    status: ToothRecordStatus.COMPLETED,
  },
  {
    patientIndex: 4,
    dentistIndex: 1,
    daysAgo: 16,
    toothNumber: '11',
    surfaces: [VESTIBULAR],
    catalogCode: 'DX-PIGMENTACION',
    status: ToothRecordStatus.COMPLETED,
  },
  {
    patientIndex: 14,
    dentistIndex: 0,
    daysAgo: 6,
    toothNumber: '46',
    surfaces: [],
    catalogCode: 'DX-AUSENTE',
    status: ToothRecordStatus.COMPLETED,
  },
];

/**
 * DX-120: anulación con motivo de un hallazgo mal registrado (índice en
 * DEMO_TOOTH_RECORDS); la anula su autor. Se ve tachado en el historial.
 */
export const DEMO_TOOTH_RECORD_VOIDS: readonly {
  recordIndex: number;
  dentistIndex: number;
  reason: string;
}[] = [
  {
    recordIndex: 1,
    dentistIndex: 0,
    reason: 'Era el 24, no el 25: registrado en el diente equivocado.',
  },
];

/**
 * DX-120: odontopediatría. Sofía (índice 8, nacida en 2015) tiene dentición
 * mixta. Los eventos fijan las posiciones de los registros temporales, así la
 * demo no depende de su edad el día que se siembre: el 65 y el 84 caben
 * porque las posiciones 25 y 44 quedan en mixta, y el 75 ya exfolió.
 */
export const DEMO_PEDIATRIC = {
  patientIndex: 8,
  dentistIndex: 1,
  events: [
    {
      positions: ['25', '44'],
      dentition: DentitionType.MIXED,
      reason: DentitionEventReason.MANUAL,
    },
    {
      positions: ['35'],
      dentition: DentitionType.PERMANENT,
      reason: DentitionEventReason.EXFOLIATION,
    },
  ],
  records: [
    {
      daysAgo: 12,
      toothNumber: '65',
      surfaces: [OCCLUSAL],
      catalogCode: 'DX-CARIES',
      status: ToothRecordStatus.COMPLETED,
      origin: ToothRecordOrigin.THIS_CLINIC,
    },
    {
      daysAgo: 12,
      toothNumber: '84',
      surfaces: [OCCLUSAL],
      catalogCode: 'OP-RESINA-1',
      status: ToothRecordStatus.COMPLETED,
      origin: ToothRecordOrigin.PRE_EXISTING,
      notes: 'Resina que ya traía al llegar a la clínica.',
    },
    {
      daysAgo: 12,
      toothNumber: '46',
      surfaces: [OCCLUSAL],
      catalogCode: 'OP-RESINA-1',
      status: ToothRecordStatus.COMPLETED,
      origin: ToothRecordOrigin.OTHER_PROVIDER,
      notes: 'Hecha por su odontólogo anterior.',
    },
  ],
} as const;

export interface DemoPlanItem {
  code: string;
  tooth: string;
  surfaces?: ToothSurface[];
  status: TreatmentPlanItemStatus;
  /** Descuento en la moneda del plan sobre la tarifa del catálogo (DX-012). */
  discount?: number;
  /**
   * DX-204: motivo del descuento y quién lo da. Sin `discountBy`, el
   * odontólogo del plan (tope 10 %); `owner`, la administradora (tope 100 %),
   * que por encima del 10 % tiene que dar el motivo.
   */
  discountReason?: DiscountReason;
  discountBy?: 'owner';
  /**
   * DX-050: un DONE de antes de la producción atribuible: sin quién, sede ni
   * fecha («Sin atribuir» en la ficha y en los reportes).
   */
  unattributed?: true;
}

interface DemoPayment {
  daysAgo: number;
  /** Con él, el abono es de hace esos minutos (y `daysAgo` es 0). */
  minutesAgo?: number;
  amount: number;
  /**
   * DX-375: moneda del abono si no es la del plan (`DEMO_CURRENCY`): VES, que
   * congela la tasa manual de su día (la demo las siembra todas, así que
   * ninguno queda «sin tasa» y la demo no depende del proveedor).
   */
  currency?: string;
  method: PaymentMethod;
  /**
   * DX-377: con ella el abono se cobra con el medio demo «Pago móvil» (pide
   * referencia) en vez del medio inicial de `method`.
   */
  mobileReference?: string;
  location: DemoLocationKey;
  notes?: string;
}

export interface DemoPlan {
  patientIndex: number;
  dentistIndex: number;
  status: TreatmentPlanStatus;
  notes: string;
  items: DemoPlanItem[];
  payments: DemoPayment[];
  /**
   * DX-012: el paciente acepta el presupuesto firmando en la tableta (en la
   * sede principal). El plan se crea en DRAFT y la aceptación lo pasa a
   * ACCEPTED, con sus ítems.
   */
  signedAcceptance?: true;
  /**
   * DX-145: días desde que se abrió el plan (su `createdAt`). Es la fecha desde
   * la que envejece en la cartera el saldo que no está en cuotas, así que la
   * demo deja deudores en los cuatro tramos (0–30, 31–60, 61–90 y > 90). Sin
   * él, el plan es de hoy. Siempre anterior a sus abonos.
   */
  openedDaysAgo?: number;
  /**
   * DX-050: sede donde se hicieron sus procedimientos realizados (por
   * defecto, la principal). Los hace el odontólogo del plan y se fechan el día
   * del primer abono (o hoy, sin abonos).
   */
  doneAt?: DemoLocationKey;
  /**
   * DX-253: el plan se cancela DESPUÉS de sus abonos (un plan cancelado no
   * admite abonos), así lo abonado queda como saldo a favor del paciente para
   * probar «Aplicar a otro plan» y «Devolver».
   */
  cancelledAfterPayments?: true;
  /** Plan de pagos (cuotas) sobre el total facturable del plan. */
  paymentPlan?: {
    downPayment: number;
    installmentsCount: number;
    startDaysAgo: number;
  };
}

const { PROPOSED, ACCEPTED, DONE } = TreatmentPlanItemStatus;
const { CASH, CARD, TRANSFER, OTHER } = PaymentMethod;

export const DEMO_PLANS: readonly DemoPlan[] = [
  {
    patientIndex: 1,
    dentistIndex: 0,
    status: TreatmentPlanStatus.ACCEPTED,
    notes: 'Rehabilitación de 36 con implante y corona.',
    openedDaysAgo: 60,
    items: [
      { code: 'IMG-RX-PANORAMICA', tooth: '36', status: DONE },
      { code: 'CX-EXO-SIMPLE', tooth: '36', status: DONE },
      { code: 'IMPL-IMPLANTE', tooth: '36', status: ACCEPTED },
      { code: 'IMPL-CORONA', tooth: '36', status: ACCEPTED },
    ],
    payments: [
      {
        daysAgo: 52,
        amount: 1040,
        method: TRANSFER,
        location: 'principal',
        notes: 'Cuota inicial del plan de pagos',
      },
      { daysAgo: 21, amount: 750, method: CARD, location: 'principal' },
    ],
    // Arranca hace 45 días (mensual): la cuota inicial y la 1 quedan cubiertas
    // por los dos abonos, y la 2 (vencida hace ~2 semanas) sin pagar, para que
    // el estado de cuenta de la demo enseñe saldo Y una cuota vencida (DX-011).
    paymentPlan: {
      downPayment: 1040,
      installmentsCount: 6,
      startDaysAgo: 45,
    },
  },
  {
    patientIndex: 2,
    dentistIndex: 1,
    status: TreatmentPlanStatus.COMPLETED,
    notes: 'Profilaxis y resinas.',
    doneAt: 'norte',
    items: [
      { code: 'PREV-PROFILAXIS', tooth: '11', status: DONE },
      { code: 'OP-RESINA-1', tooth: '16', surfaces: [OCCLUSAL], status: DONE },
      {
        code: 'OP-RESINA-2',
        tooth: '26',
        surfaces: [OCCLUSAL, MESIAL],
        status: DONE,
      },
    ],
    payments: [
      { daysAgo: 42, amount: 200, method: CASH, location: 'norte' },
      { daysAgo: 35, amount: 260, method: CARD, location: 'norte' },
    ],
  },
  {
    patientIndex: 3,
    dentistIndex: 0,
    status: TreatmentPlanStatus.ACCEPTED,
    notes: 'Endodoncia y rehabilitación de 46.',
    openedDaysAgo: 40,
    items: [
      { code: 'IMG-RX-PERIAPICAL', tooth: '46', status: DONE },
      { code: 'ENDO-MULTI', tooth: '46', status: DONE },
      { code: 'PROT-CORONA-PROV', tooth: '46', status: ACCEPTED },
      { code: 'PROT-CORONA-LM', tooth: '46', status: PROPOSED },
    ],
    payments: [
      { daysAgo: 26, amount: 400, method: CARD, location: 'principal' },
      // DX-377: «Pago móvil» en bolívares (300 USD a la tasa de su día).
      {
        daysAgo: 12,
        amount: demoVes(300, 12),
        currency: DEMO_RATE_CURRENCY,
        method: TRANSFER,
        mobileReference: '7788 3104 21',
        location: 'principal',
      },
      // DX-375: un abono de hoy en otra moneda que la del plan: efectivo en
      // bolívares (45 USD a la tasa de hoy).
      {
        daysAgo: 0,
        minutesAgo: 30,
        amount: demoVes(45, 0),
        currency: DEMO_RATE_CURRENCY,
        method: CASH,
        location: 'principal',
        notes: 'Abono en bolívares.',
      },
    ],
  },
  {
    patientIndex: 4,
    dentistIndex: 1,
    status: TreatmentPlanStatus.DRAFT,
    // DX-012: el presupuesto «presentable» de la demo (sin firmar todavía),
    // con un descuento para que la vista imprimible lo enseñe.
    notes: 'Presupuesto estético (pendiente de aprobación).',
    items: [
      { code: 'EST-BLANQ-CONSULTORIO', tooth: '11', status: PROPOSED },
      {
        code: 'EST-CARILLA-RESINA',
        tooth: '21',
        surfaces: [VESTIBULAR],
        status: PROPOSED,
        discount: 38,
      },
      {
        code: 'EST-CARILLA-RESINA',
        tooth: '22',
        surfaces: [VESTIBULAR],
        status: PROPOSED,
        // DX-204: 15 % de la administradora, con motivo (sale en el informe).
        discount: 57,
        discountReason: 'PROMOTION',
        discountBy: 'owner',
      },
    ],
    payments: [],
  },
  {
    patientIndex: 5,
    dentistIndex: 0,
    status: TreatmentPlanStatus.CANCELLED,
    notes: 'Cirugía de cordales: el paciente decidió posponerla.',
    items: [
      { code: 'CX-CORDAL-INCL', tooth: '38', status: PROPOSED },
      { code: 'CX-CORDAL-INCL', tooth: '48', status: PROPOSED },
    ],
    payments: [],
  },
  {
    // DX-253: abonado y luego cancelado → 300.000 a favor del paciente, que
    // tiene vivo el tratamiento periodontal de abajo (destino del traspaso).
    patientIndex: 6,
    dentistIndex: 1,
    status: TreatmentPlanStatus.ACCEPTED,
    notes: 'Blanqueamiento: el paciente desistió tras pagarlo (saldo a favor).',
    doneAt: 'norte',
    openedDaysAgo: 40,
    items: [{ code: 'IMPL-CORONA', tooth: '11', status: ACCEPTED }],
    payments: [{ daysAgo: 30, amount: 300, method: CASH, location: 'norte' }],
    cancelledAfterPayments: true,
  },
  {
    patientIndex: 6,
    dentistIndex: 1,
    status: TreatmentPlanStatus.ACCEPTED,
    notes: 'Tratamiento periodontal por cuadrantes.',
    doneAt: 'norte',
    openedDaysAgo: 75,
    items: [
      { code: 'PERIO-RASPADO', tooth: '16', status: DONE },
      { code: 'PERIO-RASPADO', tooth: '26', status: DONE },
      { code: 'PERIO-RASPADO', tooth: '36', status: ACCEPTED },
      { code: 'PERIO-RASPADO', tooth: '46', status: ACCEPTED },
    ],
    payments: [
      { daysAgo: 18, amount: 180, method: CASH, location: 'norte' },
      {
        daysAgo: 4,
        amount: 180,
        method: OTHER,
        location: 'norte',
        notes: 'Pago por Nequi',
      },
    ],
  },
  {
    patientIndex: 7,
    dentistIndex: 0,
    status: TreatmentPlanStatus.COMPLETED,
    notes: 'Urgencia y endodoncia de 21.',
    items: [
      // DX-050: realizado antes de la producción atribuible.
      { code: 'URG-CONSULTA', tooth: '21', status: DONE, unattributed: true },
      { code: 'ENDO-UNI', tooth: '21', status: DONE },
    ],
    payments: [
      { daysAgo: 58, amount: 90, method: CASH, location: 'principal' },
      { daysAgo: 50, amount: 450, method: CARD, location: 'principal' },
    ],
  },
  {
    patientIndex: 8,
    dentistIndex: 1,
    status: TreatmentPlanStatus.ACCEPTED,
    notes: 'Prevención odontopediátrica.',
    doneAt: 'norte',
    openedDaysAgo: 100,
    items: [
      { code: 'PED-SELLANTE', tooth: '16', surfaces: [OCCLUSAL], status: DONE },
      { code: 'PED-SELLANTE', tooth: '26', surfaces: [OCCLUSAL], status: DONE },
      { code: 'PED-FLUOR', tooth: '11', status: ACCEPTED },
    ],
    payments: [
      {
        daysAgo: 14,
        amount: demoVes(130, 14),
        currency: DEMO_RATE_CURRENCY,
        method: TRANSFER,
        mobileReference: '1234 5598 00',
        location: 'norte',
      },
    ],
  },
  {
    patientIndex: 10,
    dentistIndex: 0,
    status: TreatmentPlanStatus.ACCEPTED,
    notes: 'Resinas en molares.',
    openedDaysAgo: 20,
    items: [
      {
        code: 'OP-RESINA-3',
        tooth: '36',
        surfaces: [MESIAL, OCCLUSAL, DISTAL],
        status: DONE,
      },
      { code: 'OP-RESINA-1', tooth: '47', surfaces: [OCCLUSAL], status: DONE },
      { code: 'PREV-PROFILAXIS', tooth: '11', status: PROPOSED },
    ],
    payments: [
      { daysAgo: 7, amount: 230, method: CARD, location: 'principal' },
      // DX-051: el paciente pagó 60000 de más sobre lo facturable (500000):
      // ese importe queda «sin imputar» en la demo.
      { daysAgo: 2, amount: 330, method: CASH, location: 'principal' },
    ],
  },
  {
    // DX-012: presupuesto ACEPTADO CON FIRMA (fractura incisal del 21).
    patientIndex: 11,
    dentistIndex: 1,
    status: TreatmentPlanStatus.DRAFT,
    notes: 'Rehabilitación de 21 tras fractura incisal.',
    items: [
      { code: 'IMG-RX-PERIAPICAL', tooth: '21', status: PROPOSED },
      { code: 'ENDO-UNI', tooth: '21', status: PROPOSED },
      { code: 'PROT-CORONA-PROV', tooth: '21', status: PROPOSED },
      {
        code: 'PROT-CORONA-LM',
        tooth: '21',
        status: PROPOSED,
        discount: 120,
        discountReason: 'LOYALTY',
      },
    ],
    signedAcceptance: true,
    payments: [],
  },
];

/**
 * DX-040: un paciente con DOS OPCIONES del mismo tratamiento (reponer el 46
 * ausente), presentadas hace 9 días en la sede principal y sin cita futura:
 * aparece en «Presupuestos por seguir» y en la ficha se comparan lado a lado.
 * El seed le quita a este paciente las citas futuras del calendario.
 */
export const DEMO_PLAN_OPTIONS = {
  patientIndex: 9,
  dentistIndex: 0,
  presentedDaysAgo: 9,
  location: 'principal' as DemoLocationKey,
  notes: 'Reposición del 46 ausente: el paciente compara implante y puente.',
  options: [
    {
      label: 'Opción A: implante',
      items: [
        { code: 'IMPL-IMPLANTE', tooth: '46' },
        { code: 'IMPL-CORONA', tooth: '46' },
      ],
    },
    {
      label: 'Opción B: puente fijo',
      items: [
        { code: 'PROT-PUENTE', tooth: '45' },
        { code: 'PROT-PUENTE', tooth: '46' },
        { code: 'PROT-PUENTE', tooth: '47' },
      ],
    },
  ],
} as const;

interface DemoInventoryItem {
  location: DemoLocationKey;
  name: string;
  sku: string;
  unit: string;
  minStock: number;
  movements: {
    type: InventoryMovementType;
    quantity: number;
    reason: string;
  }[];
}

const { IN, OUT, ADJUSTMENT } = InventoryMovementType;

/** Varios ítems quedan por debajo del mínimo a propósito (alerta de stock). */
export const DEMO_INVENTORY: readonly DemoInventoryItem[] = [
  {
    location: 'principal',
    name: 'Guantes de nitrilo talla M',
    sku: 'GUA-NTR-M',
    unit: 'caja x100',
    minStock: 10,
    movements: [
      { type: IN, quantity: 30, reason: 'Compra a proveedor' },
      { type: OUT, quantity: 12, reason: 'Consumo del mes' },
      { type: OUT, quantity: 9, reason: 'Consumo del mes' },
    ],
  },
  {
    location: 'principal',
    name: 'Lidocaína 2% con epinefrina',
    sku: 'ANE-LID-2',
    unit: 'cartucho',
    minStock: 50,
    movements: [
      { type: IN, quantity: 100, reason: 'Compra a proveedor' },
      { type: OUT, quantity: 38, reason: 'Consumo en procedimientos' },
    ],
  },
  {
    location: 'principal',
    name: 'Resina compuesta A2',
    sku: 'RES-A2',
    unit: 'jeringa 4 g',
    minStock: 5,
    movements: [
      { type: IN, quantity: 8, reason: 'Compra a proveedor' },
      { type: OUT, quantity: 4, reason: 'Consumo en procedimientos' },
    ],
  },
  {
    location: 'principal',
    name: 'Eyectores de saliva',
    sku: 'EYE-SAL',
    unit: 'bolsa x100',
    minStock: 3,
    movements: [
      { type: IN, quantity: 10, reason: 'Compra a proveedor' },
      { type: OUT, quantity: 2, reason: 'Consumo del mes' },
    ],
  },
  {
    location: 'principal',
    name: 'Hipoclorito de sodio 5,25%',
    sku: 'HIP-525',
    unit: 'litro',
    minStock: 2,
    movements: [
      { type: IN, quantity: 6, reason: 'Compra a proveedor' },
      { type: OUT, quantity: 3, reason: 'Consumo en endodoncias' },
      { type: ADJUSTMENT, quantity: -1, reason: 'Envase dañado' },
    ],
  },
  {
    location: 'principal',
    name: 'Fresas de diamante redondas',
    sku: 'FRE-DIA-R',
    unit: 'unidad',
    minStock: 20,
    movements: [
      { type: IN, quantity: 40, reason: 'Compra a proveedor' },
      { type: OUT, quantity: 15, reason: 'Desgaste' },
    ],
  },
  {
    location: 'norte',
    name: 'Guantes de nitrilo talla S',
    sku: 'GUA-NTR-S',
    unit: 'caja x100',
    minStock: 8,
    movements: [
      { type: IN, quantity: 20, reason: 'Compra a proveedor' },
      { type: OUT, quantity: 6, reason: 'Consumo del mes' },
    ],
  },
  {
    location: 'norte',
    name: 'Algodón en rollos',
    sku: 'ALG-ROL',
    unit: 'paquete',
    minStock: 5,
    movements: [
      { type: IN, quantity: 6, reason: 'Compra a proveedor' },
      { type: OUT, quantity: 3, reason: 'Consumo del mes' },
    ],
  },
  {
    location: 'norte',
    name: 'Ionómero de vidrio',
    sku: 'ION-VID',
    unit: 'kit',
    minStock: 2,
    movements: [
      { type: IN, quantity: 3, reason: 'Compra a proveedor' },
      { type: OUT, quantity: 2, reason: 'Consumo en procedimientos' },
    ],
  },
  {
    location: 'norte',
    name: 'Baberos desechables',
    sku: 'BAB-DES',
    unit: 'paquete x500',
    minStock: 2,
    movements: [
      { type: IN, quantity: 5, reason: 'Compra a proveedor' },
      { type: OUT, quantity: 1, reason: 'Consumo del mes' },
    ],
  },
];

/**
 * DX-037: política de tratamiento de datos v1 de la clínica demo. Texto de
 * ejemplo sin citar la ley de ningún país (cada clínica pone la suya); el de
 * datos sensibles trae el aviso de que autorizarlo es voluntario.
 */
export const DEMO_PRIVACY_POLICY = {
  policyText: [
    `${DEMO_CLINIC_NAME}, como responsable del tratamiento, recoge y trata los datos personales de sus pacientes conforme a la normativa de protección de datos aplicable.`,
    'Finalidades: prestar la atención odontológica, llevar la historia clínica, agendar y recordar citas, facturar y cumplir obligaciones legales.',
    'Derechos del titular: conocer, actualizar, rectificar y suprimir sus datos, revocar la autorización y presentar reclamaciones ante la autoridad de protección de datos competente.',
    'Canal de atención: recepción de la clínica o el correo de contacto publicado en la sede.',
  ].join('\n\n'),
  generalText:
    'Autorizo el tratamiento de mis datos personales de identificación y contacto para las finalidades descritas en la política.',
  sensitiveHealthText:
    'Autorizo de forma expresa el tratamiento de mis datos sensibles de salud (historia clínica, odontograma, radiografías y antecedentes médicos). Se me informó que no estoy obligado a autorizar el tratamiento de datos sensibles. Finalidad: prestar la atención odontológica y conservar la historia clínica según la ley.',
  marketingText:
    'Autorizo recibir comunicaciones comerciales (promociones, campañas y recordatorios no clínicos) por teléfono, WhatsApp o correo. Puedo revocarlo en cualquier momento.',
};

// DX-006: plantillas de consentimiento informado de la demo. Textos de
// ejemplo, redactados para probar el flujo; cada clínica debe revisarlos con su
// asesor legal antes de usarlos de verdad.
export interface DemoConsentTemplate {
  title: string;
  body: string;
}

export const DEMO_CONSENT_TEMPLATES: readonly DemoConsentTemplate[] = [
  {
    title: 'Consentimiento informado — Exodoncia',
    body: [
      'Yo, {{paciente}}, identificado(a) con {{documento}}, autorizo a {{profesional}}, de {{clinica}}, a realizar el siguiente procedimiento: {{tratamiento}}.',
      'Se me ha explicado que la exodoncia consiste en la extracción del diente y que puede presentar dolor, inflamación, sangrado, infección, alveolitis, lesión de dientes vecinos o adormecimiento temporal o permanente del labio o la lengua.',
      'He podido hacer preguntas, se me han explicado las alternativas (incluida la de no tratarme) y entiendo que puedo revocar este consentimiento antes del procedimiento.',
      'Fecha: {{fecha}}.',
    ].join('\n\n'),
  },
  {
    title: 'Consentimiento informado — Endodoncia',
    body: [
      'Yo, {{paciente}}, identificado(a) con {{documento}}, autorizo a {{profesional}}, de {{clinica}}, a realizar el tratamiento de conductos: {{tratamiento}}.',
      'Se me ha explicado que el tratamiento busca conservar el diente, que puede requerir varias citas y que existen riesgos como dolor posoperatorio, fractura de instrumentos, perforaciones o la necesidad de retratamiento o extracción si no hay éxito.',
      'Entiendo que el diente tratado debe restaurarse después (resina o corona) para evitar fracturas.',
      'Fecha: {{fecha}}.',
    ].join('\n\n'),
  },
  {
    title: 'Consentimiento informado — Blanqueamiento dental',
    body: [
      'Yo, {{paciente}}, identificado(a) con {{documento}}, autorizo a {{profesional}}, de {{clinica}}, a realizar un blanqueamiento dental: {{tratamiento}}.',
      'Se me ha explicado que el resultado varía en cada persona, que no aclara restauraciones ni coronas, y que puede producir sensibilidad dental o irritación de las encías de forma temporal.',
      'Me comprometo a seguir las indicaciones de cuidado posteriores al tratamiento.',
      'Fecha: {{fecha}}.',
    ].join('\n\n'),
  },
];

/**
 * El consentimiento firmado de la demo: el paciente del plan de implante (que
 * incluye una exodoncia del 36) firma la plantilla de exodoncia con su plan.
 */
export const DEMO_SIGNED_CONSENT = {
  patientIndex: 1,
  dentistIndex: 0,
  templateIndex: 0,
} as const;

// ---------------------------------------------------------------------------
// DX-007: periodontograma. Un paciente con dos exámenes FINAL: el inicial
// (hace ~6 meses, periodontitis en molares, mucho sangrado) y el control
// reciente tras raspado y alisado (bolsas más bajas, menos sangrado), para ver
// la comparación. Los cordales (18, 28, 38, 48) van omitidos (ausentes).
// ---------------------------------------------------------------------------

export type DemoPerioSite = 'MB' | 'B' | 'DB' | 'ML' | 'L' | 'DL';

export interface DemoPerioSiteMeasure {
  toothFdi: number;
  site: DemoPerioSite;
  probingMm: number;
  recessionMm: number;
  furcation: number | null;
  bleeding: boolean;
  suppuration: boolean;
  plaque: boolean;
  calculus: boolean;
}

export interface DemoPerioExam {
  daysAgo: number;
  notes: string;
  phase: 'baseline' | 'control';
}

export const DEMO_PERIO = {
  patientIndex: 2,
  dentistIndex: 0,
  skippedTeeth: [18, 28, 38, 48],
  exams: [
    {
      daysAgo: 182,
      notes:
        'Examen inicial. Periodontitis estadio III localizada en molares. Se indica raspado y alisado radicular.',
      phase: 'baseline',
    },
    {
      daysAgo: 12,
      notes:
        'Control a los 6 meses del raspado. Mejoría clara del sangrado y de las bolsas en molares.',
      phase: 'control',
    },
  ] as const satisfies readonly DemoPerioExam[],
} as const;

const DEMO_PERIO_SITES: readonly DemoPerioSite[] = [
  'MB',
  'B',
  'DB',
  'ML',
  'L',
  'DL',
];

/** Dientes presentes (sin cordales) en orden FDI. */
function demoPerioTeeth(): number[] {
  const teeth: number[] = [];
  for (const quadrant of [1, 2, 3, 4]) {
    for (let tooth = 1; tooth <= 7; tooth += 1)
      teeth.push(quadrant * 10 + tooth);
  }
  return teeth;
}

/**
 * Medidas deterministas: molares (6, 7) con bolsas profundas en el inicial y
 * ~2 mm menos en el control; el resto, surco sano. Interproximales (M/D) más
 * profundos que los centrales, como en la clínica real.
 */
export function demoPerioMeasures(phase: DemoPerioExam['phase']): {
  sites: DemoPerioSiteMeasure[];
  teeth: { toothFdi: number; mobility: number | null; skipped: boolean }[];
} {
  const sites: DemoPerioSiteMeasure[] = [];
  const teeth: {
    toothFdi: number;
    mobility: number | null;
    skipped: boolean;
  }[] = DEMO_PERIO.skippedTeeth.map((toothFdi) => ({
    toothFdi,
    mobility: null,
    skipped: true,
  }));
  for (const toothFdi of demoPerioTeeth()) {
    const position = toothFdi % 10;
    const molar = position >= 6;
    DEMO_PERIO_SITES.forEach((site, i) => {
      const interproximal = site !== 'B' && site !== 'L';
      let probing = interproximal ? 3 : 2;
      if (molar) probing = interproximal ? 6 + (i % 2) : 4;
      if (phase === 'control') probing = Math.max(2, probing - (molar ? 2 : 0));
      const recession = molar ? (phase === 'baseline' ? 1 : 2) : 0;
      const seed = (toothFdi + i) % 5;
      sites.push({
        toothFdi,
        site,
        probingMm: probing,
        recessionMm: recession,
        furcation:
          molar && site === 'B' ? (phase === 'baseline' ? 2 : 1) : null,
        bleeding:
          phase === 'baseline' ? molar || seed === 0 : molar && seed === 0,
        suppuration: phase === 'baseline' && molar && seed === 1,
        plaque: phase === 'baseline' ? seed <= 2 : seed === 0,
        calculus: phase === 'baseline' && molar && interproximal,
      });
    });
    if (molar) {
      teeth.push({
        toothFdi,
        mobility: phase === 'baseline' ? 1 : 0,
        skipped: false,
      });
    }
  }
  return { sites, teeth };
}

// ---------------------------------------------------------------------------
// DX-013: recetas. Tres plantillas típicas (las crea el ADMIN), el registro
// profesional y la especialidad de los odontólogos, los ajustes de la receta
// de la clínica y una receta emitida post-exodoncia para el paciente del plan
// de implante (sin alergias a esos fármacos). DX-324: una sola receta, sin
// reglas por país; lo que imprime lo deciden los ajustes de la clínica.
// ---------------------------------------------------------------------------

export interface DemoPrescriptionItem {
  activeIngredient: string;
  concentration: string;
  pharmaceuticalForm: string;
  route: string;
  dose: string;
  frequency: string;
  durationDays: number;
  totalQuantity: number;
  quantityUnit: string;
  packages?: number;
  instructions?: string;
}

export interface DemoPrescriptionTemplate {
  name: string;
  notes?: string;
  items: DemoPrescriptionItem[];
}

const AMOXICILINA_500: DemoPrescriptionItem = {
  activeIngredient: 'Amoxicilina',
  concentration: '500 mg',
  pharmaceuticalForm: 'Cápsula',
  route: 'Oral',
  dose: '1 cápsula',
  frequency: 'Cada 8 horas',
  durationDays: 7,
  totalQuantity: 21,
  quantityUnit: 'cápsulas',
  packages: 1,
  instructions: 'Completar el tratamiento aunque desaparezcan las molestias.',
};

const IBUPROFENO_600: DemoPrescriptionItem = {
  activeIngredient: 'Ibuprofeno',
  concentration: '600 mg',
  pharmaceuticalForm: 'Tableta recubierta',
  route: 'Oral',
  dose: '1 tableta',
  frequency: 'Cada 8 horas',
  durationDays: 3,
  totalQuantity: 9,
  quantityUnit: 'tabletas',
  packages: 1,
  instructions: 'Tomar después de las comidas.',
};

const CLORHEXIDINA_012: DemoPrescriptionItem = {
  activeIngredient: 'Clorhexidina gluconato',
  concentration: '0,12 %',
  pharmaceuticalForm: 'Solución para enjuague bucal',
  route: 'Bucal (enjuague)',
  dose: '15 ml',
  frequency: 'Cada 12 horas',
  durationDays: 10,
  totalQuantity: 1,
  quantityUnit: 'frasco de 300 ml',
  packages: 1,
  instructions:
    'Enjuagar 30 segundos sin diluir, después del cepillado. No comer ni beber en los 30 minutos siguientes.',
};

export const DEMO_PRESCRIPTION_TEMPLATES: readonly DemoPrescriptionTemplate[] =
  [
    {
      name: 'Antibiótico — Amoxicilina 500 mg',
      notes: 'Profilaxis o infección odontogénica.',
      items: [AMOXICILINA_500],
    },
    {
      name: 'Analgésico — Ibuprofeno 600 mg',
      items: [IBUPROFENO_600],
    },
    {
      name: 'Enjuague — Clorhexidina 0,12 %',
      items: [CLORHEXIDINA_012],
    },
  ];

/** Nº de registro profesional de los odontólogos demo. */
export const DEMO_PROFESSIONAL_LICENSES: readonly string[] = [
  'LIC-DEMO-5219',
  'LIC-DEMO-2521',
];

/** Especialidad de los odontólogos demo, en el mismo orden (DX-324). */
export const DEMO_PROFESSIONAL_SPECIALTIES: readonly string[] = [
  'Cirugía oral',
  'Odontología general',
];

/**
 * Ajustes de la receta de la demo (DX-324): cantidad en letras, nº de
 * historia clínica y 30 días, para que el A4 de ejemplo enseñe todo.
 */
export const DEMO_PRESCRIPTION_SETTINGS = {
  printQuantityInWords: true,
  requireClinicalRecordNumber: true,
  validityDays: 30,
} as const;

export const DEMO_PRESCRIPTION = {
  patientIndex: 1,
  dentistIndex: 0,
  notes:
    'Post-exodoncia del 36: dieta blanda y frío local las primeras 24 horas.',
  items: [AMOXICILINA_500, IBUPROFENO_600],
} as const;

// DX-121: tipos de cita de la demo, con color para la agenda en columnas. El
// ámbar es claro a propósito: la tarjeta tiene que elegir texto oscuro sola.
// `reasons`: motivos del calendario de la demo que se agendan con ese tipo
// (el resto de las citas queda sin tipo, como las anteriores a DX-121).
export interface DemoAppointmentType {
  name: string;
  durationMinutes: number;
  color: string;
  reasons: readonly string[];
  /** DX-446: tipo de urgencia (los huecos reservados son para él). */
  isUrgent?: boolean;
}

export const DEMO_APPOINTMENT_TYPES: readonly DemoAppointmentType[] = [
  {
    name: 'Valoración',
    durationMinutes: 30,
    color: '#0E7490',
    reasons: ['Valoración inicial'],
  },
  {
    name: 'Limpieza',
    durationMinutes: 45,
    color: '#16A34A',
    reasons: ['Profilaxis y control', 'Raspaje y alisado radicular'],
  },
  {
    name: 'Endodoncia',
    durationMinutes: 90,
    color: '#7C3AED',
    reasons: ['Endodoncia (sesión de seguimiento)'],
  },
  {
    name: 'Consulta de urgencia',
    durationMinutes: 30,
    color: '#DC2626',
    reasons: ['Urgencia: dolor dental'],
    isUrgent: true,
  },
  {
    name: 'Control de ortodoncia',
    durationMinutes: 30,
    color: '#FBBF24',
    reasons: ['Control de ortodoncia'],
  },
];

// DX-122: bloqueos de agenda y «Pendientes por agendar» de la demo.
// - Vacaciones de la segunda dentista de lunes a viernes de la semana siguiente
//   a la próxima (fuera del calendario: no pisan citas), en todas las sedes.
// - Almuerzo del equipo en la sede principal el próximo día laborable, que
//   deja agendar (con aviso): se crea confirmando las citas que caigan dentro.
// - Pendientes: las cancelaciones y no-shows del calendario entran solas; se
//   dejan abiertas las `keepOpen` más recientes, las demás se descartan con
//   motivo (historial), y se añade un alta manual urgente.
export const DEMO_VACATION = {
  dentistIndex: 1,
  note: 'Vacaciones de mitad de año',
} as const;

/**
 * DX-233: rotación de ejemplo de la segunda dentista entre las dos sedes:
 * lunes, miércoles y viernes en la principal (su horario completo) y martes y
 * jueves en la Norte (el de la Norte). Sus citas demo siguen esta rotación
 * (ver `planAppointments`). Y una excepción tras sus vacaciones: ese lunes no
 * va a la principal y cubre la Norte por la mañana.
 */
export const DEMO_ROTATION = {
  dentistIndex: 1,
  weekdays: { principal: [1, 3, 5], norte: [2, 4] },
  ranges: {
    principal: [
      { startMinute: 9 * 60, endMinute: 13 * 60 },
      { startMinute: 15 * 60, endMinute: 19 * 60 },
    ],
    norte: [
      { startMinute: 7 * 60, endMinute: 12 * 60 },
      { startMinute: 13 * 60, endMinute: 17 * 60 },
    ],
  },
  cover: {
    ranges: [{ startMinute: 7 * 60, endMinute: 12 * 60 }],
    note: 'Cubre la Sede Norte',
  },
} as const;

/**
 * DX-446: hueco «Urgencias» reservado para «Consulta de urgencia» en la agenda
 * de la primera dentista (sede principal), de 15:00 a 15:30 los próximos días
 * laborables (hoy incluido si lo es). Se libera a las 11:00 de la sede: pasada
 * esa hora la agenda lo muestra «Libre desde 11:00» y admite cualquier tipo.
 */
export const DEMO_RESERVED_URGENCY = {
  dentistIndex: 0,
  days: 5,
  startMinute: 15 * 60,
  endMinute: 15 * 60 + 30,
  releaseAtMinute: 11 * 60,
  typeName: 'Consulta de urgencia',
  note: 'Urgencias',
} as const;

export const DEMO_LUNCH = {
  startMinute: 12 * 60 + 30,
  endMinute: 13 * 60,
  note: 'Almuerzo del equipo',
} as const;

/**
 * DX-247: alertas médicas en la agenda. Jorge Eduardo Ramírez (prótesis
 * valvular) sale con «Requiere premedicación» y es el primero en entrar hoy al
 * panel «En clínica»; Ana María Zapata tiene la anamnesis de hace 14 meses
 * («Anamnesis caducada», vigencia de 12); la de Gustavo Ríos es de hace 13
 * meses pero la dentista confirmó «Sin cambios hoy» (al día). Los pacientes
 * sin `medicalHistory` (p. ej. Daniela Montoya) salen «Sin anamnesis».
 */
export const DEMO_MEDICAL_ALERTS = {
  premedicationPatientIndex: 1,
  backdated: [
    { patientIndex: 13, monthsAgo: 14, confirmNoChanges: false },
    { patientIndex: 16, monthsAgo: 13, confirmNoChanges: true },
  ],
} as const;

export const DEMO_WAITLIST = {
  keepOpen: 2,
  dismissReason: 'Ya reagendó por teléfono',
  manual: {
    patientIndex: 5,
    dentistIndex: 0,
    preferredWindow: 'Mañanas, antes de las 11',
    note: 'Dolor en el 46: darle el primer hueco que haya.',
  },
} as const;

// DX-128: bloque «Comunicaciones» de la ficha. Todos nacen con el canal de la
// clínica (EMAIL); recepción deja a unos pocos en los otros estados para
// verlos en la ficha y en los recordatorios: WhatsApp con opt-in en persona,
// ninguno, baja anotada por recepción y un teléfono fijo (móvil no válido).
export const DEMO_COMMUNICATION = [
  {
    patientIndex: 0,
    input: {
      contactChannel: 'WHATSAPP',
      whatsappOptIn: true,
      whatsappOptInSource: 'IN_PERSON',
    },
  },
  // DX-210: el pendiente urgente de la lista también dio el permiso de
  // WhatsApp: en «Ocupar este hueco» sale con «Ofrecer por WhatsApp».
  {
    patientIndex: 5,
    input: { whatsappOptIn: true, whatsappOptInSource: 'IN_PERSON' },
  },
  { patientIndex: 2, input: { contactChannel: 'NONE' } },
  { patientIndex: 3, input: { reminderOptOut: true } },
  { patientIndex: 4, input: { phone: '0414 555 0405' } },
] as const;

// ---------------------------------------------------------------------------
// DX-203: responsables de pago y avisos. La abuela Martha Lucía Becerra
// (paciente) es la pagadora principal de Sofía y de Mateo: su ficha muestra
// «Responsable de» y el estado de cuenta familiar. Los avisos de Sofía van a
// su madre Claudia (contacto sin ficha; la abuela solo paga); los de Mateo, a
// la abuela (su padre Óscar no tiene email).
// ---------------------------------------------------------------------------

export interface DemoResponsible {
  patientIndex: number;
  /** Otro paciente de la demo, o un contacto sin ficha. */
  responsiblePatientIndex?: number;
  contact?: {
    fullName: string;
    docType: DocumentType;
    docNumber: string;
    email?: string;
    phone: string;
  };
  relationship: 'MOTHER' | 'FATHER' | 'GRANDPARENT';
  isPayer: boolean;
  receivesNotices: boolean;
}

export const DEMO_RESPONSIBLES: readonly DemoResponsible[] = [
  {
    patientIndex: 8,
    responsiblePatientIndex: 6,
    relationship: 'GRANDPARENT',
    isPayer: true,
    receivesNotices: false,
  },
  {
    patientIndex: 8,
    contact: {
      fullName: 'Claudia Navarro',
      docType: 'NATIONAL_ID',
      docNumber: 'DEMO-C01',
      email: 'claudia.navarro@example.com',
      phone: '+58 424 555 0209',
    },
    relationship: 'MOTHER',
    isPayer: false,
    receivesNotices: true,
  },
  {
    patientIndex: 12,
    responsiblePatientIndex: 6,
    relationship: 'GRANDPARENT',
    isPayer: true,
    receivesNotices: true,
  },
  {
    patientIndex: 12,
    contact: {
      fullName: 'Óscar Cifuentes',
      docType: 'NATIONAL_ID',
      docNumber: 'DEMO-C02',
      phone: '+58 424 555 0213',
    },
    relationship: 'FATHER',
    isPayer: false,
    receivesNotices: true,
  },
];

// ---------------------------------------------------------------------------
// DX-191: registro de implantes. El paciente del plan de implante recibe el
// implante y su pilar en el 36 (con la tarjeta pendiente de entregar) y otro
// paciente recibió un implante del MISMO lote en el 46: buscar ese lote en
// Ajustes → Implantes devuelve a los dos.
// ---------------------------------------------------------------------------

export const DEMO_IMPLANT_RECALL_LOT = 'DEMO-LOT-2026A';

export interface DemoImplant {
  patientIndex: number;
  dentistIndex: number;
  daysAgo: number;
  toothNumber: string;
  kind: 'IMPLANT' | 'ABUTMENT';
  manufacturer: string;
  system: string;
  reference: string;
  lot: string;
  diameterMm?: number;
  lengthMm?: number;
  sanitaryRegistration: string;
}

export const DEMO_IMPLANTS: readonly DemoImplant[] = [
  {
    patientIndex: 1,
    dentistIndex: 0,
    daysAgo: 10,
    toothNumber: '36',
    kind: 'IMPLANT',
    manufacturer: 'Straumann',
    system: 'BLT Roxolid SLActive',
    reference: '021.5310',
    lot: DEMO_IMPLANT_RECALL_LOT,
    diameterMm: 4.1,
    lengthMm: 10,
    sanitaryRegistration: 'REG-2019-0019876',
  },
  {
    patientIndex: 1,
    dentistIndex: 0,
    daysAgo: 10,
    toothNumber: '36',
    kind: 'ABUTMENT',
    manufacturer: 'Straumann',
    system: 'BLT Roxolid SLActive',
    reference: '022.4200',
    lot: 'DEMO-PIL-0420',
    sanitaryRegistration: 'REG-2019-0019876',
  },
  {
    patientIndex: 4,
    dentistIndex: 1,
    daysAgo: 25,
    toothNumber: '46',
    kind: 'IMPLANT',
    manufacturer: 'Straumann',
    system: 'BLT Roxolid SLActive',
    reference: '021.5310',
    lot: DEMO_IMPLANT_RECALL_LOT,
    diameterMm: 4.1,
    lengthMm: 10,
    sanitaryRegistration: 'REG-2019-0019876',
  },
];

// ---------------------------------------------------------------------------
// DX-150: cobranza. Gestiones de cobro y un compromiso de pago abierto sobre
// dos deudores de la cartera (planes abiertos hace 100 y 75 días), para ver la
// última gestión y el compromiso en /caja/cartera, el bloque «Cobranza» en la
// ficha y el chip «Saldo vencido» en sus citas. Sin datos clínicos en el texto.
// ---------------------------------------------------------------------------
export interface DemoCollectionNote {
  patientIndex: number;
  channel: CollectionChannel;
  outcome: CollectionOutcome;
  text?: string;
}

export const DEMO_COLLECTION_NOTES: readonly DemoCollectionNote[] = [
  {
    patientIndex: 8,
    channel: CollectionChannel.CALL,
    outcome: CollectionOutcome.NO_ANSWER,
  },
  {
    patientIndex: 8,
    channel: CollectionChannel.WHATSAPP_LINK,
    outcome: CollectionOutcome.PROMISED_PAYMENT,
    text: 'La mamá abona en la sede principal antes de la próxima cita.',
  },
  {
    patientIndex: 6,
    channel: CollectionChannel.CALL,
    outcome: CollectionOutcome.WILL_PAY_AT_APPOINTMENT,
    text: 'Pagará en su próxima cita.',
  },
];

/** Compromiso abierto: importe en USD y días desde hoy (día de la sede). */
export const DEMO_PAYMENT_PROMISE = {
  patientIndex: 8,
  amount: 100,
  dueInDays: 5,
  location: 'principal' as DemoLocationKey,
};

/**
 * DX-274: gastos de la sede principal, en USD. Días relativos a hoy (el día de
 * la sede): `invoice`/`due`/`paid` negativos son pasado. Uno pagado del todo,
 * uno pagado a medias con el vencimiento ya pasado (sale «Vencido») y uno
 * pendiente con plazo.
 */
export const DEMO_EXPENSES = [
  {
    category: 'Arriendo',
    supplier: 'Inmobiliaria Centro',
    description: 'Alquiler del local del mes',
    amount: 1800,
    invoice: -14,
    due: null,
    payment: { amount: 1800, method: 'TRANSFER' as const, paid: -12 },
  },
  {
    category: 'Servicios públicos',
    supplier: 'Empresas Públicas',
    description: 'Energía y agua del mes',
    amount: 420,
    invoice: -20,
    due: -5,
    payment: { amount: 150, method: 'TRANSFER' as const, paid: -10 },
  },
  {
    category: 'Laboratorio',
    supplier: 'Laboratorio Dental Sonrisa',
    description: 'Coronas del mes',
    amount: 680,
    invoice: -3,
    due: 12,
    payment: null,
  },
];

/**
 * DX-274: salida de caja menor del turno de la tarde (el abierto, nunca el
 * cerrado: su arqueo ya cuadraba). Baja 18 USD el efectivo esperado.
 */
export const DEMO_CASH_OUTFLOW = {
  category: 'Mensajería',
  supplier: 'Mensajería Rápida',
  description: 'Envío de impresiones al laboratorio',
  amount: 18,
};

/**
 * DX-222: indicaciones postoperatorias de la demo. Se cargan las 5 plantillas
 * de ejemplo y se vinculan para que la cita sugiera la correcta: por
 * procedimiento del catálogo (códigos de `default-dental-catalog`) o por tipo
 * de cita (nombre de `DEMO_APPOINTMENT_TYPES`). La demo no tiene un tipo de
 * cita de cirugía, así que el cordal se vincula solo por procedimiento y la
 * endodoncia enseña el vínculo por tipo de cita. `delivered` sale impresa para
 * la última cita atendida de un día anterior.
 */
export const DEMO_POSTOP = {
  links: [
    { code: 'POI-EXO', catalogCodes: ['CX-EXO-SIMPLE'], appointmentTypes: [] },
    {
      code: 'POI-CORDAL',
      catalogCodes: ['CX-EXO-QUIRURGICA', 'CX-CORDAL-ERUP', 'CX-CORDAL-INCL'],
      appointmentTypes: [],
    },
    { code: 'POI-ENDO', catalogCodes: [], appointmentTypes: ['Endodoncia'] },
  ],
  delivered: 'POI-EXO',
} as const;

/**
 * DX-099: un cuestionario de anamnesis enviado por enlace y pendiente de
 * revisión, para que el doctor lo vea en «Anamnesis por revisar» al entrar.
 * Natalia (índice 2, anamnesis «sana») declara ahora alergia a la penicilina,
 * asma y un anticonceptivo oral: la revisión los marca como añadidos y
 * cambiados frente a su versión vigente.
 */
export const DEMO_ANAMNESIS_SUBMISSION: {
  patientIndex: number;
  answers: AnamnesisAnswers;
} = {
  patientIndex: 2,
  answers: {
    allergies: {
      answer: 'SI',
      items: [
        {
          alergeno: 'Penicilina',
          tipo: 'MEDICAMENTO',
          severidad: 'MODERADA',
          reaccion: 'Ronchas y picor',
        },
      ],
    },
    conditions: ANAMNESIS_CONDITIONS.map((c) => ({
      codigo: c.codigo,
      answer: c.codigo === 'ASMA' ? ('SI' as const) : ('NO' as const),
      ...(c.codigo === 'ASMA' ? { nota: 'Inhalador si hace ejercicio' } : {}),
    })),
    medications: {
      answer: 'SI',
      items: [{ nombre: 'Anticonceptivo oral', frecuencia: 'Diario' }],
    },
    anticoagulants: { answer: 'NO' },
    habits: {
      tabaquismo: { answer: 'NO' },
      alcohol: { answer: 'SI', frecuencia: 'Fines de semana' },
      bruxismo: { answer: 'NO_SE' },
    },
    pregnancy: { answer: 'NO' },
    surgeries: { answer: 'NO' },
  },
};

/**
 * DX-279: política de cancelación de la sede principal (24 h de aviso, cargo
 * sugerido de 50 USD) y una paciente con incidencias para ver la insignia
 * «2 inasistencias · 1 cancelación tardía (12 meses)» en su ficha y en sus
 * citas: Daniela Montoya Arango, con dos inasistencias y una cancelación con
 * 5 h de aviso en citas de la semana pasada en la sede principal (en huecos
 * libres del calendario). Las cancelaciones del calendario se
 * registran como avisadas por el paciente 2 días antes (no tardías).
 */
export const DEMO_CANCELLATION = {
  location: 'principal' as DemoLocationKey,
  policy: {
    noticeHours: 24,
    suggestedFee: 50,
    currency: DEMO_CURRENCY,
    patientText:
      'Si no puedes asistir, avísanos con al menos 24 horas de antelación para ofrecer tu hora a otro paciente. Las cancelaciones con menos aviso y las inasistencias pueden tener un cargo.',
  },
  calendarNoticeHours: 48,
  calendarReasons: ['ILLNESS', 'WORK', 'TRANSPORT', 'FORGOT'] as const,
  incidents: {
    patientIndex: 4,
    dentistIndex: 0,
    /** Huecos que se prueban (hora de pared de la sede, en minutos). */
    firstMinute: 7 * 60,
    lastMinute: 18 * 60,
    /** Dentro de la semana pasada del calendario (nada de hace más de 15 días). */
    lastDaysAgo: 14,
    noShowDaysAgo: [9, 10] as const,
    lateCancellation: {
      daysAgo: 11,
      hoursBefore: 5,
      reasonCode: 'WORK' as const,
    },
    /**
     * DX-291/DX-321: las incidencias de la paciente de arriba se pueden
     * cobrar, y la inasistencia de otro paciente (Jorge Eduardo Ramírez) con
     * la política comunicada también.
     */
    chargeable: { patientIndex: 1, noShowDaysAgo: 8 },
  },
};

/**
 * DX-014: historia de «Comparar sedes» (ver `planComparisonHistory`). Un día
 * en cada mes con dos visitas atendidas por sede de la primera dentista (sin
 * horario propio), cada una con su procedimiento realizado allí y cobrado
 * entero en la sede (sin saldo: no entra en la cartera). Pacientes sin planes
 * ni convenios de la demo. Huecos fuera de las plantillas del calendario,
 * dentro del horario de cada sede (también el sábado).
 */
export const DEMO_COMPARISON_HISTORY = {
  dentistIndex: 0,
  reason: 'Profilaxis y control',
  patientIndexes: [14, 15, 17, 18],
  slots: {
    principal: [
      [10 * 60, 30],
      [12 * 60 + 30, 30],
    ],
    norte: [
      [8 * 60, 30],
      [9 * 60 + 15, 45],
    ],
  },
  procedures: {
    previous: ['PREV-PROFILAXIS', 'PREV-PROFILAXIS'],
    current: ['OP-RESINA-1', 'PREV-PROFILAXIS'],
  },
} as const;
