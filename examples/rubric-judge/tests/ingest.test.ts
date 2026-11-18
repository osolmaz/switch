import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8 } from "fflate";
import { afterEach, describe, expect, it } from "vitest";
import { readDocx } from "../src/ingest/docx.ts";
import { readEmail } from "../src/ingest/email.ts";
import { extractFile, MAX_IMAGE_SIDE, MAX_PAGES } from "../src/ingest/extract.ts";
import { ingestCase } from "../src/ingest/ingest.ts";
import { Package } from "../src/ingest/ooxml.ts";
import { unitPages } from "../src/ingest/pages.ts";
import { hasTextLayer, readPdf } from "../src/ingest/pdf.ts";
import { readPptx } from "../src/ingest/pptx.ts";
import { pnmSize, systemTools, type Tools } from "../src/ingest/tools.ts";
import { countWords, htmlText, textUnits } from "../src/ingest/units.ts";
import { readXlsx } from "../src/ingest/xlsx.ts";
import { loadCase } from "../src/load.ts";
import { docxBytes, emailBytes, pdfBytes, pptxBytes, xlsxBytes, zip } from "./helpers/office.ts";

const PNG = new Uint8Array([137, 80, 78, 71]);
/** The text of the Word file of `docxBytes`, laid out on two pages. */
const WORD_PAGES = ["Terms Rent is due monthly", "Party Role"];
/** Tools that render every page as `PNG` and lay out every office file as the pages of `WORD_PAGES`. */
const tools: Tools = {
	renderPages: async (pdf, _, maxPages) => (await readPdf(pdf)).slice(0, maxPages).map(() => PNG),
	toPdf: () => Promise.resolve(pdfBytes(WORD_PAGES)),
	docText: () => Promise.resolve("legacy text"),
	fitImage: (_, format) => Promise.resolve({ bytes: PNG, mimeType: format === "jpeg" ? "image/jpeg" : "image/png" }),
	versions: () => Promise.resolve({ pdftoppm: "test" }),
};
const failing = (message: string) => () => Promise.reject(new Error(message));

/** A gray PPM image of the given size. */
function ppm(width: number, height: number): Uint8Array {
	const header = new TextEncoder().encode(`P6\n# made by a test\n${String(width)} ${String(height)}\n255\n`);
	const image = new Uint8Array(header.length + width * height * 3).fill(128);
	image.set(header);
	return image;
}

/** The width and height in a PNG's header. */
const pngSize = (png: Uint8Array) => {
	const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
	return { width: view.getUint32(16), height: view.getUint32(20) };
};

describe("text", () => {
	it("splits long text into groups of lines and counts words", () => {
		expect(textUnits("a\nb")).toEqual([{ label: "all", text: "a\nb" }]);
		const units = textUnits(Array.from({ length: 5 }, (_, index) => `line ${String(index)}`).join("\n"), "rows", 2);
		expect(units.map((unit) => unit.label)).toEqual(["rows 1-2", "rows 3-4", "rows 5-5"]);
		expect(countWords(units)).toBe(10);
	});

	it("keeps an HTML page's visible text and decodes entities", () => {
		expect(htmlText("<style>p{}</style><p>A &amp; B&nbsp;&#67;&#x44;</p><br/>&unknown;")).toBe(
			" A & B CD\n\n&unknown;",
		);
	});
});

describe("Word", () => {
	it("reads numbered paragraphs with styles, tables, tracked changes, comments and formatted runs", () => {
		const word = readDocx(docxBytes());
		expect(word.units[0]?.text).toBe(
			"P1 [Heading1]: Terms\nP2: Rent is due monthly\nTABLE 1:\n  row 1: Party | Role",
		);
		expect(word.marks).toBe(3);
		expect(word.formatting).toBe(
			[
				"Tracked insertions: 1; tracked deletions: 1.",
				"  inserted: monthly",
				"  deleted: weekly",
				"Comments: 1.",
				"  comment: Check this",
				"Runs with direct formatting: 1.",
				"  P2 b: Rent",
			].join("\n"),
		);
		expect(readDocx(docxBytes(false)).marks).toBe(2);
	});

	it("refuses a Word file without a body, and an archive without the part asked for", () => {
		const empty = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>';
		expect(() => readDocx(zip({ "word/document.xml": empty }))).toThrow(/no body/);
		expect(() => new Package(zip({})).xml("missing.xml")).toThrow(/no part missing.xml/);
	});
});

describe("spreadsheet", () => {
	it("reads each sheet's rows with values in their columns", () => {
		const units = readXlsx(xlsxBytes());
		expect(units[0]).toEqual({ label: "sheet Fees", text: "row 1: Item |  | Amount\nrow 2: Rent |  | 2500" });
		expect(units[1]).toEqual({ label: "sheet Long", text: "row 1: 0\nrow 2: 1\nrow 3: 2" });
	});

	it("splits a long sheet and stops after its row limit", () => {
		const units = readXlsx(xlsxBytes(2005));
		const long = units.filter((unit) => unit.label.startsWith("sheet Long"));
		expect(long[0]?.label).toBe("sheet Long rows 1-120");
		expect(long.at(-1)?.text.endsWith("[more rows not shown]")).toBe(true);
	});
});

describe("slides, email and PDF", () => {
	it("reads slides in their numbered order", () => {
		expect(readPptx(pptxBytes())).toEqual([
			{ label: "slide 2", text: "Second" },
			{ label: "slide 10", text: "Last" },
		]);
	});

	it("reads an email's headers, text and attachment names, and its HTML when it has no plain text", async () => {
		const [plain] = await readEmail(emailBytes());
		expect(plain?.text).toContain("From: Ana Lee <ana@example.com>\nTo: Team: bo@example.com, cy@example.com\nDate:");
		expect(plain?.text).toContain("Subject: Lease\n\nPlease review.\n[attachment: lease.pdf]");
		const [html] = await readEmail(emailBytes(true));
		expect(html?.text).toContain("Please & review");
		expect(html?.text).not.toContain("x()");
	});

	it("reads each PDF page's text and finds the pages without a text layer", async () => {
		const units = await readPdf(pdfBytes(["Section 4.2 sets a notice period of thirty days.", ""]));
		expect(units.map((unit) => unit.label)).toEqual(["page 1", "page 2"]);
		expect(units[0]?.text).toContain("notice period");
		expect(units.map((unit) => hasTextLayer(unit.text))).toEqual([true, false]);
	});
});

describe("unitPages", () => {
	it("finds the pages that share runs of words with each unit, across line breaks and the reader's labels", () => {
		const pages = [
			"The tenant pays the rent on the first day of each month.",
			"Either party may end the lease with thirty days of notice.",
		];
		const units = [
			{
				label: "a",
				text: "P1: The tenant pays the rent\non the first day of each month. Either party may end the lease with thirty",
			},
			{ label: "b", text: "P2: Either party may end the lease with thirty days of notice." },
		];
		expect(unitPages(units, pages)).toEqual([[1, 2], [2]]);
	});

	it("puts a unit that matches no page between the pages of its neighbours", () => {
		const pages = ["one two three four five six", "seven eight nine ten eleven", "twelve thirteen fourteen fifteen"];
		const units = [
			{ label: "a", text: "one two three four five six" },
			{ label: "b", text: "unrelated" },
			{ label: "c", text: "twelve thirteen fourteen fifteen" },
			{ label: "d", text: "also unrelated" },
		];
		expect(unitPages(units, pages)).toEqual([[1], [1, 2, 3], [3], [3]]);
		expect(unitPages([{ label: "a", text: "x" }], [])).toEqual([[]]);
		expect(unitPages([{ label: "a", text: "x" }], ["y", "z"])).toEqual([[1, 2]]);
	});
});

describe("extractFile", () => {
	it("chooses the reader by extension", async () => {
		expect((await extractFile("a.docx", docxBytes(), tools)).format).toBe("docx");
		expect((await extractFile("a.xlsx", xlsxBytes(), tools)).format).toBe("sheet");
		expect((await extractFile("a.pptx", pptxBytes(), tools)).format).toBe("slides");
		expect((await extractFile("a.eml", emailBytes(), tools)).format).toBe("email");
		expect((await extractFile("a.doc", PNG, tools)).units).toEqual([
			{ label: "all", text: "legacy text", pages: [1, 2] },
		]);
		expect((await extractFile("page.html", strToU8("<b>Hi</b>"), tools)).units[0]?.text).toBe(" Hi ");
		expect((await extractFile("NOTES", strToU8("plain"), tools)).format).toBe("text");
		expect(await extractFile("photo.JPG", PNG, tools)).toMatchObject({
			format: "image",
			pages: [{ number: 1, image: { mimeType: "image/jpeg" }, hasText: false }],
		});
		expect(await extractFile("frame.ppm", PNG, tools)).toMatchObject({
			format: "image",
			pages: [{ number: 1, image: { mimeType: "image/png" } }],
		});
		expect(await extractFile("model.bin", PNG, tools)).toMatchObject({ format: "other", units: [] });
		await expect(extractFile("photo.webp", PNG, tools)).rejects.toThrow("webp images are not supported");
	});
});

describe("pages", () => {
	it("gives every page of a PDF its image, its text layer, and each page's unit", async () => {
		const pdf = await extractFile(
			"scan.pdf",
			pdfBytes(["", "Readable text on the second page of this file."]),
			tools,
		);
		expect(pdf.pages).toEqual([
			{ number: 1, image: { bytes: PNG, mimeType: "image/png" }, hasText: false },
			{ number: 2, image: { bytes: PNG, mimeType: "image/png" }, hasText: true },
		]);
		expect(pdf.units.map((unit) => unit.pages)).toEqual([[1], [2]]);
		expect(pdf.warnings).toEqual([]);
	});

	it("lays an office file out as pages and finds the pages of its units, keeping the reader's text", async () => {
		const word = await extractFile("a.docx", docxBytes(), tools);
		expect(word.pages.map((page) => page.number)).toEqual([1, 2]);
		expect(word.units[0]?.text).toContain("P2: Rent is due monthly");
		expect(word.units[0]?.pages).toEqual([1, 2]);
		expect(word.marks).toBe(3);
	});

	it("warns about the pages past the limit and the pages it could not render", async () => {
		const long = await extractFile("long.pdf", pdfBytes(Array.from({ length: MAX_PAGES + 1 }, () => "")), tools);
		expect(long.warnings).toEqual([
			`only the first ${String(MAX_PAGES)} of ${String(MAX_PAGES + 1)} pages have images`,
		]);
		expect(long.pages.at(-1)?.image).toBeNull();
		const short = { ...tools, renderPages: () => Promise.resolve([PNG]) };
		expect((await extractFile("a.pdf", pdfBytes(["", ""]), short)).warnings).toEqual([
			"1 of 2 pages could not be rendered",
		]);
		const broken = await extractFile("a.pdf", pdfBytes([""]), { ...tools, renderPages: failing("no renderer") });
		expect(broken.warnings).toEqual(["the pages could not be rendered: Error: no renderer"]);
		expect(broken.pages).toEqual([{ number: 1, image: null, hasText: false }]);
	});

	it("keeps the text of an office file that cannot be laid out, with a warning", async () => {
		const word = await extractFile("a.docx", docxBytes(), { ...tools, toPdf: failing("no office") });
		expect(word.pages).toEqual([]);
		expect(word.units[0]?.pages).toEqual([]);
		expect(word.units[0]?.text).toContain("P1 [Heading1]: Terms");
		expect(word.warnings).toEqual(["the file could not be laid out as pages: Error: no office"]);
	});
});

describe("systemTools pages", () => {
	it("renders each page of a PDF within the size and page limits", async () => {
		const pngs = await systemTools.renderPages(pdfBytes(["One", "Two", "Three"]), MAX_IMAGE_SIDE, 2);
		expect(pngs).toHaveLength(2);
		expect(pngs.map(pngSize)).toEqual([
			{ width: 1212, height: 1568 },
			{ width: 1212, height: 1568 },
		]);
	});

	it("lays a Word file out as a PDF with LibreOffice, and reports the programs' versions", async () => {
		const pdf = await systemTools.toPdf(docxBytes(), "docx");
		const [page] = await readPdf(pdf, " ");
		expect(page?.text.replace(/\s+/g, " ")).toContain("Rent is due monthly");
		const versions = await systemTools.versions();
		expect(versions["pdftoppm"]).toMatch(/\d+\.\d+/);
		expect(versions["soffice"]).toMatch(/\d+\.\d+/);
		const brokenArchive = strToU8("PK\u0003\u0004 not a whole archive");
		await expect(systemTools.toPdf(brokenArchive, "pptx")).rejects.toThrow("LibreOffice could not convert the file");
	}, 60_000);
});

describe("systemTools.fitImage", () => {
	it("scales an image down until no side is longer than the limit, and keeps a PNG that fits", async () => {
		expect(MAX_IMAGE_SIDE).toBe(1568);
		expect(pnmSize(ppm(3, 2))).toEqual({ width: 3, height: 2 });
		expect(() => pnmSize(PNG)).toThrow("not a PNM image");
		const wide = await systemTools.fitImage(ppm(2200, 1100), "ppm", MAX_IMAGE_SIDE);
		expect(wide.mimeType).toBe("image/png");
		expect(pngSize(wide.bytes)).toEqual({ width: 1568, height: 784 });
		const small = await systemTools.fitImage(ppm(40, 30), "ppm", MAX_IMAGE_SIDE);
		expect(pngSize(small.bytes)).toEqual({ width: 40, height: 30 });
		await expect(systemTools.fitImage(small.bytes, "png", MAX_IMAGE_SIDE)).resolves.toEqual(small);
		const tall = await systemTools.fitImage(small.bytes, "png", 20);
		expect(pngSize(tall.bytes)).toEqual({ width: 20, height: 15 });
	});
});

describe("ingestCase and loadCase", () => {
	let folder = "";
	afterEach(async () => {
		await rm(folder, { recursive: true, force: true });
	});

	it("turns an input folder into a case folder that loads back with its images", async () => {
		folder = await mkdtemp(join(tmpdir(), "switch-test-"));
		const input = join(folder, "input");
		await mkdir(join(input, "answer", "files"), { recursive: true });
		await mkdir(join(input, "documents"), { recursive: true });
		await writeFile(join(input, "request.md"), "Review the lease.");
		await writeFile(
			join(input, "rubric.json"),
			JSON.stringify({
				items: [
					{ id: "S-1", text: "PASS if it names the rent." },
					{ id: "F-1", category: "form", text: "PASS if short." },
				],
			}),
		);
		await writeFile(join(input, "answer", "files", "memo.md"), "The rent is due monthly.");
		await writeFile(join(input, "documents", "scan.pdf"), pdfBytes([""]));
		await writeFile(join(input, "documents", "broken.docx"), strToU8("not a zip"));
		await writeFile(join(input, "documents", "photo.jpg"), PNG);
		const judgeCase = await ingestCase(input, join(folder, "case"), { id: "case-1", tools });
		expect(judgeCase.files.map((file) => [file.id, file.path, file.format, file.error === null])).toEqual([
			["a1", "output/files/memo.md", "text", true],
			["d1", "documents/broken.docx", "other", false],
			["d2", "documents/photo.jpg", "image", true],
			["d3", "documents/scan.pdf", "pdf", true],
		]);
		expect(judgeCase.items[0]).toEqual({ id: "S-1", category: null, text: "PASS if it names the rent." });
		expect(judgeCase.rendering).toEqual({ pageSide: MAX_IMAGE_SIDE, programs: { pdftoppm: "test" } });
		const caseFolder = await loadCase(join(folder, "case"));
		expect(caseFolder.case).toEqual(judgeCase);
		expect(judgeCase.files[2]?.pages[0]?.image).toEqual({
			label: "documents/photo.jpg",
			path: "images/d2-1.jpg",
			mimeType: "image/jpeg",
		});
		const page = judgeCase.files[3]?.pages[0]?.image;
		expect(page).toEqual({ label: "documents/scan.pdf page 1", path: "images/d3-1.png", mimeType: "image/png" });
		if (page !== undefined && page !== null)
			await expect(caseFolder.image(page)).resolves.toMatchObject({ data: Buffer.from(PNG).toString("base64") });
		expect(JSON.parse(await readFile(join(folder, "case", "case.json"), "utf8"))).toMatchObject({ id: "case-1" });
	});

	it("refuses a case folder of another schema version", async () => {
		folder = await mkdtemp(join(tmpdir(), "switch-test-"));
		await writeFile(join(folder, "case.json"), JSON.stringify({ schema: 1, id: "old" }));
		await expect(loadCase(folder)).rejects.toThrow(
			"case.json has schema 1, and this code reads schema 2; ingest the input folder again",
		);
	});

	it("reads a case with no documents folder", async () => {
		folder = await mkdtemp(join(tmpdir(), "switch-test-"));
		await mkdir(join(folder, "in", "answer"), { recursive: true });
		await writeFile(join(folder, "in", "request.md"), "Draft a clause.");
		await writeFile(
			join(folder, "in", "rubric.json"),
			JSON.stringify({ items: [{ id: "S-1", text: "PASS if x." }] }),
		);
		await writeFile(join(folder, "in", "answer", "clause.txt"), "Clause.");
		const judgeCase = await ingestCase(join(folder, "in"), join(folder, "out"), { id: "c", tools });
		expect(judgeCase.files).toHaveLength(1);
	});
});
