import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts', 'tests/**/*.spec.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
  plugins: [
    // Vitest transpiles with esbuild by default, which cannot emit decorator
    // metadata — NestJS resolves constructor dependencies from exactly that
    // metadata, so DI silently yields undefined without this. SWC emits it.
    swc.vite({
      module: { type: 'es6' },
      jsc: {
        target: 'es2021',
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
});
