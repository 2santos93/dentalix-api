/**
 * Enmascara un número de documento para el recibo y su email (DX-136): deja
 * ver solo el final, lo justo para que el paciente lo reconozca. 8 o más
 * caracteres: los 4 últimos; de 5 a 7: los 2 últimos; 4 o menos: nada. Sin
 * documento (null o en blanco) devuelve null: nunca se inventa uno.
 */
export function maskDocument(docNumber: string | null): string | null {
  const value = docNumber?.trim() ?? '';
  if (value.length === 0) return null;
  const visible = value.length >= 8 ? 4 : value.length >= 5 ? 2 : 0;
  return (
    '*'.repeat(value.length - visible) + value.slice(value.length - visible)
  );
}
