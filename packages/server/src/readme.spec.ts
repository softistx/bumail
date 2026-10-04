import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { writeConfig } from './config/config.fixtures';
import { readConfig } from './config/read';

test("the README's configuration passes as written", async () => {
	const readme = await Bun.file(
		join(import.meta.dir, '..', 'README.md'),
	).text();
	const toml = /```toml\n([\s\S]*?)```/.exec(readme)?.[1];
	expect(toml).toBeDefined();
	const config = await readConfig({ path: writeConfig(toml ?? ''), env: {} });
	expect(config.hostname).toBe('mail.example.com');
	expect(config.smarthost?.host).toBe('smtp.example.net');
});
