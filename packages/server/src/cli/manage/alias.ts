import { type Handler, table } from './shared';

/** `bumail alias add|remove|list`: an alias delivers to local users only. */
export const alias: Handler = async (
	{ verb, operands },
	directory,
	_,
	{ out },
) => {
	const [address = '', ...targets] = operands;
	if (verb === 'add') {
		const alias = directory.aliases.add(address, targets);
		out(`added the alias ${alias.address}: ${alias.targets.join(', ')}\n`);
	} else if (verb === 'remove') {
		out(`removed the alias ${directory.aliases.remove(address).address}\n`);
	} else {
		out(
			table(
				directory.aliases
					.list(operands[0])
					.map((alias) => [alias.address, alias.targets.join(', ')]),
			),
		);
	}
};
