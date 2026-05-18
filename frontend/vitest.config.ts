import { defineConfig } from 'vitest/config';
import path from 'path';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { svelteTesting } from '@testing-library/svelte/vite';

export default defineConfig({
	plugins: [svelteTesting(), svelte()],
	resolve: {
		alias: {
			$lib: path.resolve(__dirname, 'src/lib'),
			'$app/environment': path.resolve(__dirname, 'src/tests/mocks/app-environment.ts'),
			'$app/navigation': path.resolve(__dirname, 'src/tests/mocks/app-navigation.ts'),
			'$app/stores': path.resolve(__dirname, 'src/tests/mocks/app-stores.ts'),
			'$env/dynamic/public': path.resolve(__dirname, 'src/tests/mocks/env-dynamic-public.ts'),
			// lucide-svelte's subpath exports confuse vitest's resolver; component
			// tests only need tiny renderable stand-ins.
			'lucide-svelte': path.resolve(__dirname, 'src/tests/mocks/lucide-svelte.ts')
		}
	},
	test: {
		include: ['src/**/*.test.ts'],
		environment: 'jsdom',
		globals: true,
		setupFiles: ['src/tests/setup.ts'],
		coverage: {
			provider: 'v8',
			reporter: ['text', 'json-summary', 'lcov'],
			reportsDirectory: 'coverage',
			include: ['src/**/*.{ts,svelte}'],
			exclude: [
				'src/**/*.test.ts',
				'src/tests/**',
				'src/lib/paraglide/**',
				'src/app.d.ts',
				'src/app.html'
			]
		}
	}
});
