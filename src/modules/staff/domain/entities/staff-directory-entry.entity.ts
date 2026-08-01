import { ClinicRole } from '@prisma/client';

/**
 * Estado de una persona en el directorio. `PENDING` no es un miembro todavía:
 * es una invitación vigente que aún nadie aceptó.
 */
export type StaffDirectoryStatus = 'ACTIVE' | 'INACTIVE' | 'PENDING';

/**
 * Una fila del directorio de personal: mezcla miembros (`ClinicMembership`) e
 * invitaciones pendientes (`ClinicInvitation`) en una sola lista, que es como
 * las ve el usuario en la pantalla de Personal.
 *
 * Forma PLANA a propósito, en vez de una unión discriminada por tipo: la
 * pantalla ordena, pagina y filtra las dos clases de fila juntas, y `kind`
 * basta para decidir qué acciones ofrece cada una. `id` es el `userId` cuando
 * es miembro y el id de la invitación cuando no lo es — nunca se mezclan
 * porque siempre se lee junto a `kind`.
 */
export interface StaffDirectoryEntry {
  kind: 'MEMBER' | 'INVITATION';
  id: string;
  fullName: string;
  email: string;
  role: ClinicRole;
  status: StaffDirectoryStatus;
  /** Solo en invitaciones: cuándo caduca el enlace. */
  expiresAt: Date | null;
}

/** Filtros y paginación del directorio. */
export interface StaffDirectoryQuery {
  page: number;
  pageSize: number;
  /** Coincide con nombre o correo, sin distinguir mayúsculas. */
  search?: string;
  role?: ClinicRole;
  /**
   * Sin filtro, el directorio muestra a quien puede trabajar hoy o está a
   * punto de poder: activos y pendientes. Los inactivos solo salen si se
   * piden, que es la decisión de producto que evita una lista llena de gente
   * que ya no está.
   */
  status?: StaffDirectoryStatus;
}

export interface StaffDirectoryPage {
  items: StaffDirectoryEntry[];
  total: number;
  page: number;
  pageSize: number;
}
