import { choiceType, typedKey } from "@osolmaz/switch";
import type { CaseFile, JudgeCase, Unit } from "../case.ts";
import { found, type JudgeState, type PageOf, pagesField, pagesOfUnits, SIZES, TYPES, withEvidence } from "../state.ts";
import type { Term } from "../terms.ts";

/** A term's key within the search type: one search for each term, whatever its case. */
const termKey = (term: Term): string => term.term.toLowerCase();

const choiceText = (term: Term): string => {
	const from = term.items.length > 0 ? term.items.join(", ") : "the answer";
	return `Find the passages in the answer and the documents that mention “${term.term}” (from ${from}${term.inDocuments ? "" : "; only in the answer"})`;
};

/** One passage that mentions a term, and the unit it is in. */
interface Hit {
	readonly text: string;
	readonly unit: Unit;
}

function hitsIn(file: CaseFile, needle: string, room: number): Hit[] {
	const hits: Hit[] = [];
	for (const unit of file.units) {
		const haystack = unit.text.toLowerCase();
		let at = haystack.indexOf(needle);
		while (at >= 0 && hits.length < room) {
			const around = unit.text.slice(Math.max(0, at - SIZES.hitContext), at + needle.length + SIZES.hitContext);
			const where = file.units.length > 1 ? `${file.path}, ${unit.label}` : file.path;
			hits.push({ text: `${where}: …${around.replace(/\s+/g, " ")}…`, unit });
			at = haystack.indexOf(needle, at + needle.length + SIZES.hitContext);
		}
	}
	return hits;
}

/** Every passage that mentions a term, in the answer and in the documents, and the pages that hold them. */
export function searchFiles(files: readonly CaseFile[], term: string): { text: string; pages: PageOf[] } {
	const needle = term.toLowerCase();
	const lines: string[] = [];
	const pages: PageOf[] = [];
	for (const file of files) {
		const hits = hitsIn(file, needle, SIZES.hits - lines.length);
		lines.push(...hits.map((hit) => hit.text));
		pages.push(
			...pagesOfUnits(
				file,
				hits.map((hit) => hit.unit),
			),
		);
	}
	return { text: lines.length > 0 ? lines.join("\n") : "Not found in any file.", pages };
}

/** Search one term from the rubric, or a figure or section reference the answer cites, that was not searched yet. */
export const search = (judgeCase: JudgeCase, terms: readonly Term[]) =>
	choiceType<JudgeState, Term>({
		type: TYPES.search,
		choices: (state) =>
			terms
				.filter((term) => !found(state, typedKey(TYPES.search, termKey(term))))
				.slice(0, SIZES.searchChoices)
				.map((term) => ({
					key: termKey(term),
					text: choiceText(term),
					arg: term,
					priority: 1,
					// The rubric items the term comes from, for tools that read the trace.
					data: { informs: [...term.items] },
				})),
		transition: (state, term, key) => {
			const { text, pages } = searchFiles(judgeCase.files, term.term);
			return withEvidence(state, { key, source: `search for “${term.term}”`, text, ...pagesField(pages) });
		},
	});
