// @ts-check
import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/coverage/**',
      '**/drizzle/**',
      '**/next-env.d.ts',
    ],
  },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: {
        projectService: { allowDefaultProject: ['*.js', '*.mjs'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: false },
      ],
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      'no-restricted-properties': [
        'error',
        {
          object: 'process',
          property: 'env',
          message: 'Read env through the app/package config module (src/config.ts).',
        },
      ],
    },
  },
  {
    // The one place each workspace is allowed to touch process.env.
    files: ['**/src/config.ts', '**/drizzle.config.ts'],
    rules: { 'no-restricted-properties': 'off' },
  },
  {
    // Code that Next bundles. Turbopack/webpack treat `new URL('<file>', import.meta.url)`
    // as an asset reference and copy that file into the build output (this once
    // copied .env into a publicly served folder). Build paths with node:path instead.
    files: ['apps/web/**/*.{ts,tsx}', 'packages/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            'NewExpression[callee.name="URL"] > MemberExpression.arguments[object.type="MetaProperty"][property.name="url"]',
          message:
            "Don't use new URL('…', import.meta.url) in bundled code: the bundler copies that file into the build. Use path.resolve(path.dirname(fileURLToPath(import.meta.url)), '…').",
        },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    extends: [nextPlugin.configs['core-web-vitals'], reactHooks.configs.flat['recommended-latest']],
    settings: { next: { rootDir: 'apps/web' } },
  },
  {
    files: ['**/*.js', '**/*.mjs'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
);
