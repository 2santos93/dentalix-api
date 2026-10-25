// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// DX-338: `new PrismaClient({ datasources… })` sin argumento de tipo infiere
// un `PrismaClient<{ datasources: … }>` propio de cada fichero, y pasarlo donde
// se espera `PrismaClient` obliga a TypeScript a comparar, miembro a miembro,
// el cliente entero (100+ modelos). Con ~250 clientes en test/ y prisma/ eso
// multiplicaba por 9 los tipos del programa (3,8 M), llevaba tsc a 4 GB y a
// ESLint (que usa el mismo programa) a quedarse sin heap en CI. Con
// `<Prisma.PrismaClientOptions>` el tipo es exactamente el `PrismaClient` por
// defecto y no hay nada que comparar.
const prismaClientWithoutTypeArgs = {
  selector: "NewExpression[callee.name='PrismaClient']:not([typeArguments])",
  message:
    'Escribe new PrismaClient<Prisma.PrismaClientOptions>({ … }): sin argumento de tipo, cada cliente es un tipo distinto y comparar con PrismaClient dispara la memoria de tsc y ESLint (DX-338). Si necesitas inferir las opciones (p.ej. log por eventos y $on), justifícalo con eslint-disable-next-line.',
};

export default tseslint.config(
  {
    // DX-338: nada generado ni de terceros entra en el lint (ni en su programa).
    ignores: ['eslint.config.mjs', 'dist/**', 'coverage/**', 'node_modules/**'],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
      // Convención del repo: un `_` delante marca a propósito un parámetro que
      // exige el puerto pero esta implementación no usa (`_contentType`) o una
      // clave que se separa para descartarla (`{ deletedAt: _deletedAt, ...rest }`).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      "prettier/prettier": ["error", { endOfLine: "auto" }],
      'no-restricted-syntax': ['error', prismaClientWithoutTypeArgs],
    },
  },
  {
    // Borrado duro prohibido en el código de producción. En Dentalix los datos
    // se retiran en blando (`deletedAt`), nunca se borran: es lo que permite
    // auditar una historia clínica, un abono anulado o el horario que regía en
    // una fecha pasada. La guardia en runtime está en
    // src/shared/prisma/no-hard-delete.ts y cubre todo lo que pasa por
    // `runWithTenant`; esta regla cubre además el SQL crudo y las tablas
    // globales que se tocan fuera de transacción.
    //
    // Excepción legítima (housekeeping con TTL, ficheros de un bucket): añade
    // `// eslint-disable-next-line no-restricted-syntax` con el motivo escrito
    // encima. Que cueste una línea es justamente el punto.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.spec.ts'],
    rules: {
      // Sustituye (no suma) las opciones del bloque general: se repite aquí la
      // del PrismaClient.
      'no-restricted-syntax': [
        'error',
        prismaClientWithoutTypeArgs,
        {
          selector: "CallExpression[callee.property.name='delete']",
          message:
            'Borrado duro prohibido: retira el dato con update({ deletedAt: new Date() }) y filtra { deletedAt: null } en las lecturas. Si es una excepción legítima, justifícala con eslint-disable-next-line.',
        },
        {
          selector: "CallExpression[callee.property.name='deleteMany']",
          message:
            'Borrado duro prohibido: retira los datos con updateMany({ deletedAt: new Date() }) y filtra { deletedAt: null } en las lecturas. Si es una excepción legítima, justifícala con eslint-disable-next-line.',
        },
      ],
    },
  },
);
