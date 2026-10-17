import { Injectable } from '@nestjs/common';

/**
 * Reloj de los dominios (SEC-009): caducidad de los PENDING y rondas de la
 * re-verificación leen "ahora" de aquí, para que los tests avancen el tiempo
 * (72 h, rondas sucesivas) sin dormir.
 */
@Injectable()
export class DomainClock {
  now(): Date {
    return new Date();
  }
}
