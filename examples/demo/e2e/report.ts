/** The e2e's checks, and the PASS/FAIL table they print as. */

export interface Check {
	readonly step: string;
	readonly name: string;
	readonly ok: boolean;
	readonly detail: string;
}

export class Report {
	readonly checks: Check[] = [];
	#step = '';

	/** Runs a step; a throw is one failed check of it, and the next step still runs. */
	async step(name: string, run: () => Promise<void>): Promise<void> {
		this.#step = name;
		try {
			await run();
		} catch (error) {
			this.check('ran to the end', false, `${error}`);
		}
	}

	check(name: string, ok: boolean, detail = ''): boolean {
		this.checks.push({ step: this.#step, name, ok, detail });
		return ok;
	}

	get passed(): boolean {
		return this.checks.length > 0 && this.checks.every((check) => check.ok);
	}

	print(): void {
		const width = (pick: (check: Check) => string, title: string) =>
			Math.max(title.length, ...this.checks.map((check) => pick(check).length));
		const step = width((check) => check.step, 'step');
		const name = width((check) => check.name, 'check');
		const row = (a: string, b: string, c: string, d: string) =>
			`${a.padEnd(step)}  ${b.padEnd(name)}  ${c.padEnd(8)}${d}`;
		console.log(`\n${row('step', 'check', 'result', 'detail')}`);
		console.log(row('-'.repeat(step), '-'.repeat(name), '------', '------'));
		for (const check of this.checks) {
			const detail = check.detail.replace(/\s+/g, ' ').slice(0, 100);
			console.log(
				row(check.step, check.name, check.ok ? 'PASS' : 'FAIL', detail),
			);
		}
		const failed = this.checks.filter((check) => !check.ok).length;
		console.log(
			`\n${this.passed ? 'PASS' : 'FAIL'}: ${this.checks.length - failed} of ${this.checks.length} checks passed`,
		);
	}
}
