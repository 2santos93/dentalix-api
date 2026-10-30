import { Injectable } from '@nestjs/common';
import { parseCron } from '../domain/cron';
import {
  JOB_NAME_MAX_LENGTH,
  JOB_NAME_PATTERN,
  MAX_ATTEMPTS_LIMIT,
  JobDefinition,
  JobPayload,
  ScheduleDefinition,
} from '../domain/job';

function assertName(name: string, what: string): void {
  if (name.length > JOB_NAME_MAX_LENGTH || !JOB_NAME_PATTERN.test(name)) {
    throw new Error(
      `${what}: nombre "${name}" inválido (modulo.trabajo en minúsculas, ≤ ${JOB_NAME_MAX_LENGTH})`,
    );
  }
}

/**
 * Handlers y tareas programadas de la cola (DX-085). Cada módulo registra los
 * suyos en `onModuleInit` (antes de que el worker arranque en
 * `onApplicationBootstrap`); el worker solo reclama trabajos cuyo nombre
 * conoce, así que durante un despliegue escalonado una réplica antigua no
 * coge trabajos nuevos que no sabe hacer.
 */
@Injectable()
export class JobRegistry {
  private readonly handlers = new Map<string, JobDefinition>();
  private readonly scheduled = new Map<string, Required<ScheduleDefinition>>();

  register<P extends JobPayload>(definition: JobDefinition<P>): void {
    assertName(definition.name, 'Trabajo');
    if (this.handlers.has(definition.name)) {
      throw new Error(`Trabajo "${definition.name}" ya registrado`);
    }
    const { maxAttempts } = definition;
    if (
      maxAttempts !== undefined &&
      (!Number.isInteger(maxAttempts) ||
        maxAttempts < 1 ||
        maxAttempts > MAX_ATTEMPTS_LIMIT)
    ) {
      throw new Error(
        `Trabajo "${definition.name}": maxAttempts debe estar en 1..${MAX_ATTEMPTS_LIMIT}`,
      );
    }
    this.handlers.set(definition.name, definition as unknown as JobDefinition);
  }

  schedule(definition: ScheduleDefinition): void {
    assertName(definition.name, 'Tarea programada');
    parseCron(definition.cron);
    if (!this.handlers.has(definition.job)) {
      throw new Error(
        `Tarea programada "${definition.name}": trabajo "${definition.job}" no registrado`,
      );
    }
    if (this.scheduled.has(definition.name)) {
      throw new Error(`Tarea programada "${definition.name}" ya programada`);
    }
    this.scheduled.set(definition.name, {
      ...definition,
      payload: definition.payload ?? {},
      singleton: definition.singleton ?? false,
    });
  }

  get(name: string): JobDefinition | undefined {
    return this.handlers.get(name);
  }

  names(): string[] {
    return [...this.handlers.keys()].sort();
  }

  schedules(): Required<ScheduleDefinition>[] {
    return [...this.scheduled.values()];
  }
}
