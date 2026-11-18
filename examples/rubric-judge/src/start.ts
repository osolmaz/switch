import { typedKey } from "@osolmaz/switch";
import type { CaseFile, JudgeCase } from "./case.ts";
import { lookedAt } from "./choices/look.ts";
import { type Evidence, SIZES, type JudgeState, partEvidence, partKey, TYPES, unreadParts } from "./state.ts";

/** The answer's parts read at the start, as the read choices would read them, so that those are left out. */
function readAnswerFile(file: CaseFile, room: number): { evidence: Evidence[]; tokens: number } {
	const evidence: Evidence[] = [];
	let tokens = 0;
	for (const part of unreadParts(file, new Set())) {
		if (tokens + part.tokens > room) break;
		evidence.push(partEvidence(part, typedKey(TYPES.read, partKey(part))));
		tokens += part.tokens;
	}
	return { evidence, tokens };
}

/** The images of an answer's image file, as far as the run may still see images. */
const answerImages = (file: CaseFile, seen: number): Evidence[] =>
	file.pages
		.flatMap((page) => (page.image === null ? [] : [lookedAt(file, page.number, page.image)]))
		.slice(0, Math.max(0, SIZES.images - seen));

const unreadable = (file: CaseFile): Evidence => ({
	key: `unreadable:${file.id}`,
	source: file.path,
	text: `[the file could not be read: ${file.error ?? "unknown error"}]`,
});

const formatting = (file: CaseFile): Evidence => ({
	key: typedKey(TYPES.changes, file.id),
	source: `${file.path}: formatting`,
	text: file.formatting ?? "",
});

/**
 * The initial state: the answer's files, read before the first pick. Their text up to a budget, their images and
 * their Word formatting.
 */
export function openAnswer(judgeCase: JudgeCase): JudgeState {
	const evidence: Evidence[] = [];
	let room = SIZES.answerTokens;
	for (const file of judgeCase.files.filter((candidate) => candidate.role === "answer")) {
		if (file.error !== null) {
			evidence.push(unreadable(file));
		} else if (file.format === "image") {
			evidence.push(...answerImages(file, evidence.filter((entry) => entry.image !== undefined).length));
		} else {
			const opened = readAnswerFile(file, room);
			evidence.push(...opened.evidence);
			room -= opened.tokens;
			if (file.formatting !== null) evidence.push(formatting(file));
		}
	}
	return { evidence, steps: 0, gathered: false, checks: null };
}
