import { invalid } from '../../errors';
import { checkAddress } from '../envelope';
import type { QueueOptions } from '../options';
import { HOUR, numberOf } from './numbers';

export interface DsnSettings {
	readonly from: string;
	readonly delayAfter: number | false;
	readonly returnContent: 'headers' | 'full';
}

export function dsnOf(options: QueueOptions, hostname: string): DsnSettings {
	const d = options.dsn ?? {};
	const from = checkAddress('dsn.from', d.from ?? `postmaster@${hostname}`);
	const delayAfter =
		d.delayAfter === false
			? false
			: numberOf('dsn.delayAfter', d.delayAfter, 4 * HOUR, 0);
	const returnContent = d.returnContent ?? 'headers';
	if (returnContent !== 'headers' && returnContent !== 'full') {
		throw invalid(
			`dsn.returnContent must be 'headers' or 'full', not ${returnContent}`,
		);
	}
	return { from, delayAfter, returnContent };
}
