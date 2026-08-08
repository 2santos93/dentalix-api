// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['eslint.config.mjs'],
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
      "prettier/prettier": ["error", { endOfLine: "auto" }],
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
      'no-restricted-syntax': [
        'error',
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
