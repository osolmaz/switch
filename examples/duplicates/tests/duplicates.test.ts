import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Answer, BoolQuestion, ChoiceQuestion, DecisionRequest } from "@osolmaz/switch";
import { resultSchema, runCases } from "@osolmaz/switch/cli";
import { answered, fakeDecider } from "@osolmaz/switch/testing";
import { candidatesOf, kindOf, present, type List, listView, loadList, searchMachine, TEXTS } from "../src/index.ts";
import { duplicatesSetup } from "../src/setup.ts";

/** A small list: A and B ask for the same thing, C asks for part of A, and D is something else. */
const LIST: List = {
	id: "toy",
	items: [
		{ id: "A", text: "The reply names the deadline of 3 May and the court." },
		{ id: "B", text: "The reply states the 3 May deadline and names the court." },
		{ id: "C", text: "The reply names the deadline of 3 May." },
		{ id: "D", text: "The reply is under one page." },
	],
};

/** The item that the find question names in `request` for each item, by the item's id. */
const SAME: Record<string, string> = { A: "B", B: "A", C: "A", D: "none" };
/** Whether meeting the first item always means meeting the second. */
const COVERS: Record<string, number> = { "A>B": 0.9, "B>A": 0.8, "A>C": 0.9, "C>A": 0.1 };

/** The answer to a find question: the label of the item that SAME names for the question's item. */
function findAnswer(question: ChoiceQuestion): Answer {
	const item = /^Item (\S+):/.exec(question.instructions)?.[1] ?? "";
	const target = SAME[item] === "none" ? TEXTS.none : (SAME[item] ?? TEXTS.none);
	const label = Object.entries(question.criteria).find(([, text]) => text === target)?.[0] ?? "o1";
	return { type: "choice", choice: label, probabilities: { [label]: 0.7 }, confidence: 0.7 };
}

/** The answer to a check question, from COVERS. */
function coversAnswer(question: BoolQuestion): Answer {
	const [first, second] = [...question.instructions.matchAll(/item, (\S+):/g)].map((match) => match[1] ?? "");
	return { type: "bool", probability: COVERS[`${first ?? ""}>${second ?? ""}`] ?? 0 };
}

/** Answers find questions from SAME and check questions from COVERS, as a model that sees the toy list would. */
const toyPolicy = (request: DecisionRequest) =>
	answered(
		Object.fromEntries(
			Object.entries(request.decisionQuestions).map(([id, question]) => [
				id,
				question.type === "choice" ? findAnswer(question) : coversAnswer(question as BoolQuestion),
			]),
		),
	);

let folder = "";
beforeEach(async () => {
	folder = await mkdtemp(join(tmpdir(), "duplicates-"));
});
afterEach(async () => {
	await rm(folder, { recursive: true, force: true });
});

describe("the duplicates search", () => {
	it("asks one find question per item, then checks only the pairs it named, each both ways", async () => {
		const machine = searchMachine(LIST);
		const initial = await machine.initial();
		const find = machine.questions(initial);
		expect(Object.keys(find)).toEqual(["find.0", "find.1", "find.2", "find.3"]);
		const first = find["find.0"];
		expect(first?.type === "choice" ? Object.values(first.criteria) : []).toEqual(["B", "C", "D", TEXTS.none]);
		const decider = fakeDecider(toyPolicy);
		const afterFind = await machine.transition(
			initial,
			(await decider.decide({ decisionState: {}, decisionQuestions: find })).decisionAnswers,
		);
		// A~B is named twice, A~C once, and D names none.
		expect(afterFind.candidates).toEqual([
			{ a: "A", b: "B", found: 0.7 },
			{ a: "A", b: "C", found: 0.7 },
		]);
		const check = machine.questions(afterFind);
		expect(Object.keys(check)).toEqual(["covers.0.ab", "covers.0.ba", "covers.1.ab", "covers.1.ba"]);
		const done = await machine.transition(
			afterFind,
			(await decider.decide({ decisionState: {}, decisionQuestions: check })).decisionAnswers,
		);
		expect(done.step).toBe("done");
		expect(done.checked.map(kindOf)).toEqual(["duplicate", "overlap"]);
		expect(machine.questions(done)).toEqual({});
		await expect(machine.view?.(done, 1000, 3)).resolves.toEqual(listView(LIST));
	});

	it("is done after the find step when no item names another", async () => {
		const machine = searchMachine(LIST);
		const initial = await machine.initial();
		const none = Object.fromEntries(
			Object.keys(machine.questions(initial)).map((id) => [
				id,
				{ type: "choice", choice: "o4", probabilities: { o4: 1 }, confidence: 1 } as const,
			]),
		);
		expect(await machine.transition(initial, none)).toEqual({ step: "done", candidates: [], checked: [] });
	});

	it("names every item the model gives at least the candidate threshold, and the picked one", () => {
		const choice = (probabilities: Record<string, number>, pick: string): Answer => ({
			type: "choice",
			choice: pick,
			probabilities,
			confidence: 0.4,
		});
		// For A, the labels are o1 = B, o2 = C, o3 = D and o4 = none; B picks o1 = A with no probability reported.
		const pairs = candidatesOf(LIST, {
			"find.0": choice({ o1: 0.5, o2: 0.3, o3: 0.1, o4: 0.1 }, "o1"),
			"find.1": choice({}, "o1"),
		});
		expect(pairs).toEqual([
			{ a: "A", b: "B", found: 0.5 },
			{ a: "A", b: "C", found: 0.3 },
		]);
		expect(kindOf({ a: "A", b: "B", found: 1, aCoversB: 0.2, bCoversA: 0.1 })).toBe("separate");
		expect(() => present<string>(undefined, "the item X")).toThrow("the item X is missing");
	});

	it("runs a case folder and records each pair's kind", async () => {
		const toy = join(folder, "cases", "toy");
		await mkdir(toy, { recursive: true });
		await writeFile(join(toy, "case.json"), JSON.stringify(LIST));
		expect(await loadList(toy)).toEqual(LIST);
		const out = join(folder, "run");
		await runCases(await duplicatesSetup(), [toy], fakeDecider(toyPolicy), {
			out,
			concurrency: 1,
			progress: () => undefined,
		});
		const result = resultSchema.parse(JSON.parse(await readFile(join(out, "cases", "toy", "result.json"), "utf8")));
		expect(result).toMatchObject({ steps: 2, ended: "done", thrown: null });
		expect(result.outcome).toMatchObject({ duplicates: 1, overlaps: 1 });
	});

	it("refuses a list whose items share an id, or that has fewer than two", async () => {
		await writeFile(join(folder, "case.json"), JSON.stringify({ id: "x", items: [LIST.items[0], LIST.items[0]] }));
		await expect(loadList(folder)).rejects.toThrow("two items share an id");
		await writeFile(join(folder, "case.json"), JSON.stringify({ id: "x", items: [LIST.items[0]] }));
		await expect(loadList(folder)).rejects.toThrow();
	});
});
