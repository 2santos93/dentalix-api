import { Injectable, Logger } from '@nestjs/common';

/** Lo que corre antes de cambiar la fuente de la tasa de la clínica. */
export type ExchangeSourceChangeHook = () => Promise<void>;

/**
 * DX-380: lo que corre DESPUÉS de que la clínica del contexto registre o
 * corrija una tasa manual o cambie la fuente (ya confirmado).
 */
export type ExchangeRatesChangedHook = () => Promise<void>;

/**
 * DX-375 (BE-047): lo que otros módulos necesitan hacer ANTES de que una
 * clínica cambie la fuente de su tasa, en su contexto de tenant. Los pagos
 * registran aquí congelar la tasa de todos los abonos que la esperaban, con
 * la fuente de antes: así el cambio no mueve ningún abono ya cobrado. Es un
 * registro (como `JobRegistry`) para que este módulo no dependa de los pagos,
 * que ya dependen de él. Un fallo se propaga y la fuente no cambia.
 *
 * DX-380: también lo que hacer DESPUÉS de que cambien sus tasas (una manual
 * registrada o corregida, o la fuente): los pagos adelantan los reintentos
 * aplazados de sus abonos sin tasa. El cambio ya está confirmado, así que un
 * fallo aquí no lo deshace: se registra y el reintento sigue su backoff.
 */
@Injectable()
export class ExchangeSourceChangeHooks {
  private readonly logger = new Logger('Exchange');
  private readonly hooks: ExchangeSourceChangeHook[] = [];
  private readonly afterHooks: ExchangeRatesChangedHook[] = [];

  register(hook: ExchangeSourceChangeHook): void {
    this.hooks.push(hook);
  }

  registerAfterRatesChange(hook: ExchangeRatesChangedHook): void {
    this.afterHooks.push(hook);
  }

  async beforeSourceChange(): Promise<void> {
    for (const hook of this.hooks) await hook();
  }

  /** Nunca lanza: el cambio de las tasas ya se guardó. */
  async afterRatesChange(): Promise<void> {
    for (const hook of this.afterHooks) {
      try {
        await hook();
      } catch (error) {
        this.logger.warn({
          event: 'exchange.rates_changed_hook_failed',
          error: error instanceof Error ? error.name : typeof error,
        });
      }
    }
  }
}
