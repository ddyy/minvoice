import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, 'migrations'));
  return {
    test: {
      projects: [
        {
          test: {
            name: 'unit',
            include: ['src/**/*.test.ts'],
            environment: 'node',
          },
        },
        {
          plugins: [
            cloudflareTest({
              wrangler: { configPath: './test/wrangler.test.jsonc' },
              miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
            }),
          ],
          test: {
            name: 'integration',
            include: ['test/**/*.test.ts'],
            setupFiles: ['./test/apply-migrations.ts'],
          },
        },
      ],
    },
  };
});
