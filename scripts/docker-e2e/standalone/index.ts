/** Phase 0: the standalone variant (`deploy/compose.yaml`), where bumail binds port 80 itself. */
import type { Context } from '../context';
import { certificate } from './certificate';
import { init } from './init';
import { ports } from './ports';

export async function standalone(ctx: Context): Promise<void> {
	await init(ctx);
	await certificate(ctx);
	await ports(ctx);
}
