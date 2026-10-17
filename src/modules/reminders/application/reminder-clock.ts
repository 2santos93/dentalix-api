import { Injectable } from '@nestjs/common';

/**
 * Reloj de los recordatorios (DX-026): el barrido, el handler y el estado por
 * cita leen "ahora" de aquí, para que los tests de integración puedan avanzar
 * el tiempo (48 h antes, luego 2 h antes) sin dormir.
 */
@Injectable()
export class ReminderClock {
  now(): Date {
    return new Date();
  }
}
