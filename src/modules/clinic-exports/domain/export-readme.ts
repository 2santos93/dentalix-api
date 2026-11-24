import { EXPORT_CATALOG } from './export-catalog';

/**
 * DX-053: `LEEME.txt` del ZIP: qué hay en cada fichero, cuántas filas y cómo
 * leer los formatos. Sin el nombre de la clínica ni ningún dato: solo la
 * descripción del formato y los recuentos.
 */
export function exportReadme(input: {
  startedAt: Date;
  finishedAt: Date;
  rowCounts: Record<string, number>;
}): string {
  const lines = [
    'Exportación de los datos de la clínica (Dentalix)',
    '',
    `Empezó: ${input.startedAt.toISOString()} · Terminó: ${input.finishedAt.toISOString()} (UTC).`,
    '',
    'FORMATO',
    '- Un fichero CSV por entidad, en UTF-8 con BOM (Excel lo abre con tildes), separado por comas y con la primera fila de cabeceras en español.',
    "- El texto va entre comillas. Una celda que empezaría por = + - @ lleva delante un apóstrofo (') para que la hoja de cálculo no la ejecute como fórmula.",
    '- Fechas: AAAA-MM-DD. Instantes: ISO 8601 con el desfase de la zona horaria de la sede de la fila (2026-11-21T09:30:00-04:00) o en UTC (terminados en Z) si la fila no tiene sede.',
    '- Importes con punto decimal y sin separador de miles; la moneda (código ISO 4217) va en su propia columna.',
    '- Sí/No en las columnas de casillas; vacío cuando no hay dato.',
    '- Estados, tipos y motivos van con su código (SCHEDULED, CASH…), el mismo en todas las exportaciones.',
    '- Cada fila lleva su Id (UUID) y las columnas «(id)» permiten cruzar los ficheros (p. ej. pagos.csv «Plan (id)» con planes.csv «Id»).',
    '- Se exporta TODO, también lo archivado, retirado o anulado, con la fecha en su columna.',
    '- No es una foto instantánea: un cambio hecho mientras se generaba puede verse en un fichero y no en otro.',
    '',
    'NO INCLUYE',
    '- Ficheros adjuntos (documentos, radiografías, logos) ni imágenes de las firmas: documentos.csv es el índice.',
    '- Contraseñas, códigos de verificación en dos pasos, sesiones, tokens de enlaces ni la auditoría de accesos.',
    '- Configuración (plantillas, horarios, ajustes de recordatorios).',
    '',
    'FICHEROS',
    ...EXPORT_CATALOG.map(
      (t) =>
        `- ${t.file} (${input.rowCounts[t.file] ?? 0} filas): ${t.description}`,
    ),
    '',
    'Contiene datos personales y de salud: guárdalo cifrado y bórralo cuando ya no lo necesites.',
    '',
  ];
  return lines.join('\r\n');
}
