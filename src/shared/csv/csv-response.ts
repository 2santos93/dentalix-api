import type { Response } from 'express';

export const CSV_RESPONSE = {
  description: 'Fichero CSV',
  content: { 'text/csv': { schema: { type: 'string' } } },
};

export function sendCsv(res: Response, filename: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // Datos de gestión de la clínica: ni el navegador ni un proxy los guardan.
  res.setHeader('Cache-Control', 'no-store');
}
