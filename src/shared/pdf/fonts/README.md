# Fuentes Unicode del PDF firmado (DX-459)

Fuentes **Noto** (SIL Open Font License 1.1, ver `OFL.txt`) que pdfkit
incrusta en SUBCONJUNTO cuando un PDF firmado tiene texto fuera de WinAnsi.
Las usa `../unicode-fonts.ts`; `nest build` copia esta carpeta a
`dist/shared/pdf/fonts/` (`nest-cli.json`, `assets`). Criterio, tamaño y tope:
README de la API, «Fuentes Unicode del PDF firmado (DX-459)».

| Fichero                     | Versión |      Bytes | SHA-256                                                            | Origen                                                                                                        |
| --------------------------- | ------- | ---------: | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `NotoSans-Regular.ttf`      | 2.015   |    431 364 | `f3961a9cde016d41a4879aecda1474d3a36d6bf54fa0e4643de029cc2248b0e8` | [notofonts.github.io](https://github.com/notofonts/notofonts.github.io/tree/main/fonts/NotoSans/unhinted/ttf) |
| `NotoSans-Bold.ttf`         | 2.015   |    432 376 | `87cb2d84472a7d66da659ee47b6cdb9552326e8c128245231f191b6ac72529d9` | ídem                                                                                                          |
| `NotoSansCJKsc-Regular.otf` | 2.004   | 16 437 364 | `2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b` | [noto-cjk](https://github.com/notofonts/noto-cjk/tree/main/Sans/OTF/SimplifiedChinese)                        |

- Cobertura: Noto Sans, latín + griego + cirílico (incluye todo WinAnsi); Noto
  Sans CJK SC, el CJK unificado entero (hanzi/kanji/hanja, kana, hangul) con
  las formas chinas simplificadas por defecto.
- Sin fuentes de derecha a izquierda (árabe, hebreo): sin maquetación bidi el
  dominio niega esas escrituras, así que no se distribuyen.
- Sin hinting (no hace falta en PDF) y sin modificar: los ficheros son los
  publicados, byte a byte (las huellas de arriba las comprueba
  `../unicode-fonts.spec.ts`, junto con el tope de 20 MiB de la carpeta).
- Para cambiar o añadir una fuente: descargarla de su repositorio oficial,
  comprobar tipo (`file`) y licencia (OFL), actualizar esta tabla, `OFL.txt`,
  las huellas del spec y la tabla del README de la API.
