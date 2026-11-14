// @ts-check
import js from '@eslint/js';
import astro from 'eslint-plugin-astro';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * ARC-01/ARC-02 import boundary: public code may use only the public
 * data-access layer and the shared config/headers/errors modules — never the
 * admin module, the raw schema, or the ORM directly.
 */
const publicBoundary = {
  'no-restricted-imports': [
    'error',
    {
      patterns: [
        {
          group: [
            '@cg/core/*',
            '!@cg/core/public',
            '!@cg/core/config',
            '!@cg/core/headers',
            '!@cg/core/errors',
          ],
          message:
            'Public code may import only @cg/core/public, /config, /headers and /errors (INV-1, ARC-02).',
        },
        {
          group: ['drizzle-orm', 'drizzle-orm/*', '**/packages/core/**', '../../packages/**'],
          message: 'Public code must go through @cg/core/public for data access (ARC-02).',
        },
      ],
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/.astro/**',
      '**/.wrangler/**',
      '**/node_modules/**',
      '**/worker-configuration.d.ts',
      'playwright-report/**',
      'test-results/**',
      'packages/core/migrations/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strict,
  ...astro.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      'no-console': 'off',
      eqeqeq: ['error', 'always'],
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['apps/public/**/*.{ts,astro,mjs}'],
    rules: publicBoundary,
  },
  {
    // Core's public layer may not reach into admin code either.
    files: [
      'packages/core/src/public/**/*.ts',
      'packages/core/src/config.ts',
      'packages/core/src/headers.ts',
      'packages/core/src/errors.ts',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/admin/**', '../admin/*'],
              message: 'Shared/public core code must not import admin code.',
            },
          ],
        },
      ],
    },
  },
);
