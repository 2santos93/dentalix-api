import { Injectable } from '@nestjs/common';

/** Lo que corre antes de cambiar la fuente de la tasa de la clínica. */
export type ExchangeSourceChangeHook = () => Promise<void>;

/**
 * DX-375 (BE-047): lo que otros módulos necesitan hacer ANTES de que una
 * clínica cambie la fuente de su tasa, en su contexto de tenant. Los pagos
 * registran aquí congelar la tasa de todos los abonos que la esperaban, con
 * la fuente de antes: así el cambio no mueve ningún abono ya cobrado. Es un
 * registro (como `JobRegistry`) para que este módulo no dependa de los pagos,
 * que ya dependen de él. Un fallo se propaga y la fuente no cambia.
 */
@Injectable()
export class ExchangeSourceChangeHooks {
  private readonly hooks: ExchangeSourceChangeHook[] = [];

  register(hook: ExchangeSourceChangeHook): void {
    this.hooks.push(hook);
  }

  async beforeSourceChange(): Promise<void> {
    for (const hook of this.hooks) await hook();
  }
}
