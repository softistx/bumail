import { count, type Handler, table } from './shared';

/** `bumail domain add|remove|list`. */
export const domain: Handler = async (
	{ verb, operands },
	directory,
	_,
	{ out },
) => {
	const [name = ''] = operands;
	if (verb === 'add') {
		out(`added the domain ${directory.domains.add(name).name}\n`);
	} else if (verb === 'remove') {
		out(`removed the domain ${directory.domains.remove(name)}\n`);
	} else {
		out(
			table(
				directory.domains
					.list()
					.map((domain) => [
						domain.name,
						`${count(domain.users, 'user', 'users')}, ${count(domain.aliases, 'alias', 'aliases')}`,
					]),
			),
		);
	}
};
