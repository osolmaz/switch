import { describe, expect, it } from "vitest";
import type { Choice } from "@osolmaz/switch";
import { changes, trackedChanges } from "../src/choices/changes.ts";
import { compare, compareFiles } from "../src/choices/compare.ts";
import { count, countWords } from "../src/choices/count.ts";
import { look } from "../src/choices/look.ts";
import { read } from "../src/choices/read.ts";
import { search, searchFiles } from "../src/choices/search.ts";
import { SIZES } from "../src/state.ts";
import { searchTerms } from "../src/terms.ts";
import { evidence, file, imageFile, judgeCase, pageImage, paged, stateOf } from "./helpers/cases.ts";

const texts = (choices: readonly Choice[]) => choices.map((choice) => choice.text);
const empty = stateOf();

describe("read", () => {
	it("offers a small file whole, and adds what it reads to the evidence", async () => {
		const choices = read(judgeCase())(empty);
		expect(texts(choices)).toContain("Read all of documents/lease.pdf (pdf, 2 parts, ~15 words)");
		const lease = choices.find((choice) => choice.key === "read:d1:0-1");
		await expect(lease?.next(empty)).resolves.toEqual({
			...empty,
			evidence: [
				{
					key: "read:d1:0-1",
					source: "documents/lease.pdf",
					text: "[page 1]\nSection 4.2 sets a notice period of 30 days.\n\n[page 2]\nRent is USD 2,500 a month.",
					pages: [
						{ file: "d1", page: 1 },
						{ file: "d1", page: 2 },
					],
				},
			],
		});
	});

	it("offers the unread parts of a large or partly read file, the first part ahead of the others", async () => {
		const page = "word ".repeat(4000);
		const big = judgeCase({
			files: [file("d1", "documents/big.pdf", "document", [page, page, page, ""], { format: "pdf" })],
		});
		const choices = read(big)(empty);
		expect(choices.map((choice) => [choice.key, choice.priority])).toEqual([
			["read:d1:0-0", 0],
			["read:d1:1-1", 2],
			["read:d1:2-2", 2],
		]);
		const second = await choices[1]?.next(empty);
		expect(second?.evidence[0]).toMatchObject({ source: "documents/big.pdf, page 2" });
		const partly = read(judgeCase())(stateOf(evidence("read:d1:0-0")));
		expect(texts(partly)).toContain("Read documents/lease.pdf, page 2 (6 words)");
	});

	it("offers nothing that does not fit the evidence budget, and no image or unreadable file", () => {
		const full = stateOf(evidence("read:a1:0-0", "x".repeat(SIZES.evidenceTokens * SIZES.charsPerToken)));
		expect(read(judgeCase())(full)).toEqual([]);
		const odd = judgeCase({
			files: [
				file("d1", "documents/a.png", "document", [], { format: "image" }),
				file("d2", "documents/b.doc", "document", ["x"], { error: "broken" }),
			],
		});
		expect(read(odd)(empty)).toEqual([]);
	});
});

describe("look", () => {
	const scan = paged(file("d1", "documents/scan.pdf", "document", ["", "Readable text"], { format: "pdf" }));
	const scanned = judgeCase({ files: [scan, imageFile("d2", "documents/photo.png", "document")] });
	const memo = paged(file("a1", "output/memo.docx", "answer", ["Memo page one", "Memo page two"], { format: "docx" }));
	const lease = paged(
		file("d1", "documents/lease.pdf", "document", ["Lease 1", "Lease 2", "Lease 3"], { format: "pdf" }),
	);
	const laidOut = judgeCase({ files: [memo, lease] });
	const readPage = (file: string, page: number, key = `read:${file}:${String(page)}`) =>
		evidence(key, "x", { pages: [{ file, page }] });

	it("offers pages without text and image files, and adds the image to the evidence by its label", async () => {
		const choices = look(scanned)(empty);
		expect(texts(choices)).toEqual([
			"Look at documents/scan.pdf page 1 (the page has no text layer)",
			"Look at documents/photo.png",
		]);
		await expect(choices[0]?.next(empty)).resolves.toEqual({
			...empty,
			evidence: [
				{
					key: "look:d1:1",
					source: "documents/scan.pdf page 1",
					text: "[image: documents/scan.pdf page 1]",
					image: pageImage(scan, 1),
				},
			],
		});
		const photo = await choices[1]?.next(empty);
		expect(photo?.evidence[0]).toMatchObject({ source: "documents/photo.png", text: "[image: documents/photo.png]" });
	});

	it("offers the pages whose text the evidence holds, the answer's ahead of the documents' latest first", () => {
		const state = stateOf(readPage("a1", 1), readPage("d1", 2), readPage("d1", 3, "search:lease"));
		const choices = look(laidOut)(state);
		expect(choices.map((choice) => [choice.key, choice.priority])).toEqual([
			["look:a1:1", 1],
			["look:d1:3", 1],
			["look:d1:2", 1],
		]);
		expect(texts(choices)).toEqual([
			"Look at output/memo.docx page 1 as an image (its text is in the evidence, as LibreOffice lays the file out)",
			"Look at documents/lease.pdf page 3 as an image (its text is in the evidence)",
			"Look at documents/lease.pdf page 2 as an image (its text is in the evidence)",
		]);
	});

	it("offers each page once, at most its share of choices, and none without an image or of an unknown file", () => {
		const many = paged(
			file(
				"d1",
				"documents/long.pdf",
				"document",
				Array.from({ length: 10 }, (_, index) => `Page ${String(index)}`),
				{
					format: "pdf",
				},
			),
		);
		const pages = Array.from({ length: 10 }, (_, index) => ({ file: "d1", page: index + 1 }));
		const state = stateOf(evidence("read:d1:0-9", "x", { pages: [...pages, ...pages, { file: "x9", page: 1 }] }));
		expect(look(judgeCase({ files: [many] }))(state)).toHaveLength(SIZES.pageChoices);
		const blank = { ...many, pages: many.pages.map((page) => ({ ...page, image: null })) };
		expect(look(judgeCase({ files: [blank] }))(state)).toEqual([]);
	});

	it("leaves out an image it looked at, and stops once the case has seen its images", () => {
		const image = pageImage(scan, 1);
		expect(texts(look(scanned)(stateOf(evidence("look:d1:1", "x", { image }))))).toEqual([
			"Look at documents/photo.png",
		]);
		const seen = Array.from({ length: SIZES.images }, (_, index) =>
			evidence(`look:x:${String(index)}`, "x", { image }),
		);
		expect(look(scanned)(stateOf(...seen))).toEqual([]);
	});
});

describe("search", () => {
	it("offers the case's terms with the items they come from in their data, and finds every passage", async () => {
		const graded = judgeCase();
		const choices = search(graded, searchTerms(graded))(empty);
		const notice = choices.find((choice) => choice.key === "search:notice period");
		expect(notice).toMatchObject({
			data: { informs: ["S-001"] },
			priority: 1,
			text: "Find the passages in the answer and the documents that mention “notice period” (from S-001)",
		});
		const searched = await notice?.next(empty);
		expect(searched?.evidence[0]).toMatchObject({
			key: "search:notice period",
			source: "search for “notice period”",
		});
		const again = search(graded, searchTerms(graded))(searched ?? empty);
		expect(again.map((choice) => choice.key)).not.toContain("search:notice period");
	});

	it("labels a passage with its part, keeps the pages that hold it, and says when nothing matches", async () => {
		const found = searchFiles(judgeCase().files, "rent");
		expect(found.text).toContain("documents/lease.pdf, page 2: …Rent is USD 2,500 a month.…");
		expect(found.pages).toEqual([{ file: "d1", page: 2 }]);
		expect(searchFiles(judgeCase().files, "arbitration")).toEqual({ text: "Not found in any file.", pages: [] });
		const graded = judgeCase();
		const notice = search(graded, searchTerms(graded))(empty).find((choice) => choice.key === "search:notice period");
		expect((await notice?.next(empty))?.evidence[0]?.pages).toEqual([{ file: "d1", page: 1 }]);
	});
});

describe("count", () => {
	it("is offered once when an item is about length, and counts words under each heading", async () => {
		const [choice] = count(judgeCase())(empty);
		expect(choice?.text).toBe("Count the words of the answer, in total and for each section");
		const counted = await choice?.next(empty);
		expect(counted).toEqual({
			...empty,
			evidence: [
				{
					key: "count:words",
					source: "word counts of the answer",
					text: "output/memo.md: 15 words in total.\n  Memo: 9 words\n  Advice: 2 words",
				},
			],
		});
		expect(count(judgeCase())(counted ?? empty)).toEqual([]);
		const noLength = judgeCase({ items: [{ id: "S-1", category: null, text: "PASS if it names the landlord." }] });
		expect(count(noLength)(empty)).toEqual([]);
	});

	it("counts text before the first heading too", () => {
		expect(countWords(file("a1", "output/a.md", "answer", ["one two\n**Terms**\nthree"]))).toBe(
			"output/a.md: 4 words in total.\n  (before the first heading): 2 words\n  Terms: 1 words",
		);
	});
});

describe("changes", () => {
	it("lists the tracked changes of a marked document once, without its formatted runs", async () => {
		const [choice] = changes(judgeCase())(empty);
		expect(choice?.text).toBe("List the tracked changes and comments in documents/contract.docx");
		const listed = await choice?.next(empty);
		expect(listed?.evidence).toEqual([
			{
				key: "changes:d2",
				source: "documents/contract.docx: tracked changes and comments",
				text: "Tracked insertions: 1; tracked deletions: 0.\n  inserted: agree\nComments: 0.",
			},
		]);
		expect(changes(judgeCase())(listed ?? empty)).toEqual([]);
		expect(trackedChanges(file("x", "x", "document", []))).toBe("");
	});
});

describe("compare", () => {
	const edited = file("a1", "output/Contract.docx", "answer", ["P1: The parties agree.\nP2 [Heading1]: New clause."], {
		format: "docx",
	});
	const original = file("d2", "documents/contract.docx", "document", ["P1: The parties agree.\nP2: Old clause."], {
		format: "docx",
	});

	it("pairs the answer's Word file with the document of the same name, and lists added and removed paragraphs", async () => {
		const graded = judgeCase({ files: [edited, original] });
		const [choice] = compare(graded)(empty);
		expect(choice?.text).toBe(
			"Compare output/Contract.docx with the original documents/contract.docx, paragraph by paragraph",
		);
		const compared = await choice?.next(empty);
		expect(compared?.evidence[0]).toMatchObject({
			key: "compare:a1",
			source: "output/Contract.docx compared with documents/contract.docx",
		});
		expect(compare(graded)(compared ?? empty)).toEqual([]);
		expect(compareFiles(edited, original)).toBe(
			"1 paragraphs in the answer are not in the original; 1 paragraphs of the original are not in the answer.\n+ New clause.\n- Old clause.",
		);
	});

	it("offers nothing without a matching original", () => {
		expect(compare(judgeCase({ files: [edited] }))(empty)).toEqual([]);
	});
});
