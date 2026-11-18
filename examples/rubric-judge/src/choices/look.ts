import { choiceType, typedKey, type TypedChoice } from "@osolmaz/switch";
import type { CaseFile, JudgeCase, Render } from "../case.ts";
import { type Evidence, found, imagesSeen, type JudgeState, SIZES, TYPES, withEvidence } from "../state.ts";

/** Why a page is offered: an image file, a page without a text layer, or a page whose text is in the evidence. */
type Reason = "image" | "scan" | "read";

/** A page that the model may look at: its file, its number and its image, and why it is offered. */
interface Sight {
	readonly file: CaseFile;
	readonly page: number;
	readonly image: Render;
	readonly reason: Reason;
}

/** The key of the look at one page of a file, within the look type. */
export const lookKey = (file: CaseFile, page: number): string => `${file.id}:${String(page)}`;

/** Whether ingest laid the file out as pages itself, so that its pages may differ from those of the program it came from. */
const converted = (file: CaseFile): boolean => file.format !== "pdf" && file.format !== "image";

function lookText({ file, page, reason }: Sight): string {
	if (reason === "image") return `Look at ${file.path}`;
	if (reason === "scan") return `Look at ${file.path} page ${String(page)} (the page has no text layer)`;
	const layout = converted(file) ? ", as LibreOffice lays the file out" : "";
	return `Look at ${file.path} page ${String(page)} as an image (its text is in the evidence${layout})`;
}

/** The evidence of a look at an image: its label as text, and the image, which the view loads from the case folder. */
export const lookedAt = (file: CaseFile, page: number, image: Render): Evidence => ({
	key: typedKey(TYPES.look, lookKey(file, page)),
	source: image.label,
	text: `[image: ${image.label}]`,
	image,
});

/** The page of a file as a sight, when the page has an image. */
function sightOf(file: CaseFile, page: number, reason: Reason): Sight[] {
	const image = file.pages.find((candidate) => candidate.number === page)?.image ?? null;
	return image === null ? [] : [{ file, page, image, reason }];
}

/** The pages whose text the evidence holds: the answer's first, then the documents', the latest evidence first. */
function readSights(judgeCase: JudgeCase, state: JudgeState): Sight[] {
	const files = new Map(judgeCase.files.map((file) => [file.id, file]));
	const sights = [...state.evidence].reverse().flatMap((entry) =>
		(entry.pages ?? []).flatMap((page) => {
			const file = files.get(page.file);
			return file === undefined ? [] : sightOf(file, page.page, "read");
		}),
	);
	return [
		...sights.filter((sight) => sight.file.role === "answer"),
		...sights.filter((sight) => sight.file.role !== "answer"),
	];
}

/** Image files, and the pages without a text layer, such as scans, whose content only an image shows. */
const imageSights = (judgeCase: JudgeCase): Sight[] =>
	judgeCase.files.flatMap((file) =>
		file.format === "image"
			? sightOf(file, 1, "image")
			: file.pages.filter((page) => !page.hasText).flatMap((page) => sightOf(file, page.number, "scan")),
	);

/**
 * Look at a page as an image: an image file, a page without a text layer, or a page whose text the evidence holds, so
 * that the model sees what the text leaves out, such as the layout, a chart or a signature. It offers the pages not
 * looked at yet, at most `SIZES.pageChoices` of them, until the run saw `SIZES.images` images.
 */
export const look = (judgeCase: JudgeCase) =>
	choiceType<JudgeState, Sight>({
		type: TYPES.look,
		choices(state) {
			if (imagesSeen(state) >= SIZES.images) return [];
			const offered = new Map<string, Sight>();
			for (const sight of [...readSights(judgeCase, state), ...imageSights(judgeCase)]) {
				const key = lookKey(sight.file, sight.page);
				if (!offered.has(key) && !found(state, typedKey(TYPES.look, key))) offered.set(key, sight);
			}
			return [...offered].slice(0, SIZES.pageChoices).map(([key, sight]): TypedChoice<Sight> => ({
				key,
				text: lookText(sight),
				arg: sight,
				priority: sight.reason === "read" ? 1 : 0,
			}));
		},
		transition: (state, { file, page, image }) => withEvidence(state, lookedAt(file, page, image)),
	});
