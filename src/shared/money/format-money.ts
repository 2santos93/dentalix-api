/**
 * Importe con su moneda como lo pinta la web (`formatCurrency`, locale `es`):
 * «150.000,00 COP», siempre con dos decimales. Lo usan los mensajes y los
 * correos para decir lo mismo que la pantalla. Un código que Intl no conoce
 * sale como «XYZ 10.00».
 */
export function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('es', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency} ${amount.toFixed(2)}`;
  }
}
