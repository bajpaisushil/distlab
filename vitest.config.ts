import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@distlab/shared': pkg('shared'),
      '@distlab/algorithms': pkg('algorithms'),
      '@distlab/network': pkg('network'),
      '@distlab/telemetry': pkg('telemetry'),
      '@distlab/simulation-engine': pkg('simulation-engine'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    environment: 'node',
    reporters: 'default',
  },
});
