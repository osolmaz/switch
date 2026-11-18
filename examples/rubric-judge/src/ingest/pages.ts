import type { UnitText } from "../case.ts";

/**
 * Finding the pages of a unit whose text a reader took from the file itself, such as a Word file's paragraphs, in the
 * text of the file laid out as pages. The two texts differ in their line breaks, in the labels a reader adds, such as a
 * paragraph's number, and in how a table's cells are joined, so the match compares runs of words, not lines.
 */

/** The number of words in each run that the match compares. */
export const RUN_WORDS = 4;
/** A page holds a unit when they share at least this many runs of words, or all of a shorter unit's runs. */
export const MIN_SHARED_RUNS = 3;
/**
 * …and at least this share of the runs of the smaller of the two, so that a phrase that recurs on every page, such as a
 * defined term, does not tie a unit to every page.
 */
export const MIN_SHARED_RATIO = 0.1;

const wordsOf = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

function runsOf(text: string): Set<string> {
	const words = wordsOf(text);
	const runs = new Set<string>();
	for (let start = 0; start + RUN_WORDS <= words.length; start += 1)
		runs.add(words.slice(start, start + RUN_WORDS).join(" "));
	return runs;
}

function shared(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	const [small, large] = a.size <= b.size ? [a, b] : [b, a];
	let count = 0;
	for (const run of small) if (large.has(run)) count += 1;
	return count;
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, index) => from + index);

/**
 * The units come in the file's order, and so do the pages, so a unit that no page matches, such as a short one, lies
 * between the pages of the units around it: from the last page of the unit before to the first page of the unit after.
 */
function fillGaps(matched: readonly number[][], pageCount: number): number[][] {
	return matched.map((pages, index) => {
		if (pages.length > 0 || pageCount === 0) return [...pages];
		const before = matched.slice(0, index).findLast((found) => found.length > 0);
		const after = matched.slice(index + 1).find((found) => found.length > 0);
		const from = before?.at(-1) ?? 1;
		return range(from, Math.max(from, after?.[0] ?? pageCount));
	});
}

/**
 * The numbers of the pages that hold each unit's text, given each page's text in page order. A unit that shares no runs
 * of words with any page gets the pages between those of its neighbours.
 */
export function unitPages(units: readonly UnitText[], pageTexts: readonly string[]): number[][] {
	return fillGaps(matchPages(units, pageTexts), pageTexts.length);
}

function matchPages(units: readonly UnitText[], pageTexts: readonly string[]): number[][] {
	const pages = pageTexts.map(runsOf);
	return units.map((unit) => {
		const runs = runsOf(unit.text);
		return pages.flatMap((page, index) => {
			const count = shared(runs, page);
			const needed = Math.max(
				Math.min(MIN_SHARED_RUNS, runs.size),
				MIN_SHARED_RATIO * Math.min(runs.size, page.size),
			);
			return count > 0 && count >= needed ? [index + 1] : [];
		});
	});
}
