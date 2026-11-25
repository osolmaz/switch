import {
	type Answer,
	type Answers,
	type Choice,
	definitionOf,
	type DomainShared,
	type JsonObject,
	type Limits,
	limitsJson,
	pickedChoice,
	pickQuestion,
	type PickQuestion,
	type Questions,
	type RunResult,
	type StateMachine,
	type View,
} from "@osolmaz/switch";
import type { Item, List } from "./case.ts";

/**
 * A pair that the find step named: two items in the order of the list, and the highest probability with which the
 * model named one for the other.
 */
export interface Candidate extends JsonObject {
	readonly a: string;
	readonly b: string;
	readonly found: number;
}

/** A candidate after the check step: the probability that meeting `a` always means meeting `b`, and the other way. */
export interface Checked extends Candidate {
	readonly aCoversB: number;
	readonly bCoversA: number;
}

/**
 * Where a search is. The find step asks, for each item, which other item checks the same thing; the check step asks,
 * for each pair it named, whether each item covers the other. Then the search is done.
 */
export interface SearchState extends JsonObject {
	readonly step: "find" | "check" | "done";
	readonly candidates: readonly Candidate[];
	readonly checked: readonly Checked[];
}

/** Two steps and no more, so the step limit is only a safety net. */
export const LIMITS: Limits = { steps: 3, windowShare: 0.9 };

/**
 * The texts that the model reads, and the two thresholds: a find answer names a pair when the model gives it at least
 * `candidate`, and an item covers another when the model says so with at least `covers`.
 */
export const TEXTS = {
	find: "Which other item of the list checks the same thing as this item, in full or in part? Two items check the same thing when an answer that meets one would, for the same reason, meet the other, or would meet a part of the other. Pick none when every other item checks something different, even when it is on the same subject.",
	none: "None: no other item checks the same thing",
	covers: "Does every answer that meets the first item also meet the second item?",
	yes: "Yes: an answer cannot meet the first item and fail the second",
	no: "No: an answer can meet the first item and still fail the second, because the second asks for something more or something else",
	candidate: 0.25,
	coversAt: 0.5,
	choices: 255,
} as const;

export const DUPLICATES: DomainShared = {
	name: "duplicates",
	version: "0.1.0",
	limits: LIMITS,
	definition: definitionOf("duplicates", { ...TEXTS, limits: limitsJson(LIMITS) }),
};

/** A choice of a find question: another item by its place in the list, or none. */
interface Other extends Choice {
	readonly place: number | null;
}

/** `value`, which the caller knows is there, such as an item that a candidate names. */
export function present<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`${what} is missing`);
	return value;
}

const findId = (index: number): string => `find.${String(index)}`;
const coversId = (index: number, way: "ab" | "ba"): string => `covers.${String(index)}.${way}`;

/** The find question of the item at `place`: a pick over the other items' ids and none, which a cut never leaves out. */
function findQuestion(list: List, item: Item, place: number): PickQuestion<Other> {
	const others: Other[] = list.items.flatMap((other, index) =>
		index === place ? [] : [{ type: "item", key: other.id, text: other.id, place: index }],
	);
	const none: Other = { type: "none", key: "none", text: TEXTS.none, place: null, priority: -1 };
	const instructions = `Item ${item.id}: ${item.text}\n\n${TEXTS.find}`;
	return present(pickQuestion([...others, none], instructions, TEXTS.choices), "the find question");
}

/** The places of the items that `answer` names, with their probabilities: from `TEXTS.candidate`, and the pick. */
function named(pick: PickQuestion<Other>, answer: Answer | undefined): { place: number; probability: number }[] {
	if (answer?.type !== "choice") return [];
	const labels = Object.keys(pick.question.criteria);
	const found = pick.choices.flatMap(({ place }, index) => {
		const probability = answer.probabilities[labels[index] ?? ""] ?? 0;
		return place !== null && probability >= TEXTS.candidate ? [{ place, probability }] : [];
	});
	// The picked item counts even when the decider reports a low probability for it, or none.
	const picked = pickedChoice(pick, answer).place;
	if (picked !== null && !found.some((entry) => entry.place === picked))
		found.push({ place: picked, probability: answer.confidence });
	return found;
}

/** The pairs that the find answers name, each once, in the order of the list, with the higher probability. */
export function candidatesOf(list: List, answers: Answers): Candidate[] {
	const pairs = new Map<number, { first: number; second: number; found: number }>();
	list.items.forEach((item, place) => {
		for (const { place: other, probability } of named(findQuestion(list, item, place), answers[findId(place)])) {
			const [first, second] = place < other ? [place, other] : [other, place];
			const key = first * list.items.length + second;
			pairs.set(key, { first, second, found: Math.max(probability, pairs.get(key)?.found ?? 0) });
		}
	});
	return [...pairs.entries()]
		.sort(([x], [y]) => x - y)
		.map(([, { first, second, found }]) => ({ a: idAt(list, first), b: idAt(list, second), found }));
}

const idAt = (list: List, place: number): string => present(list.items[place], `the item at ${String(place)}`).id;

/** The check question of one way of a pair: whether meeting `first` always means meeting `second`. */
function coversQuestion(first: Item, second: Item): Questions[string] {
	return {
		type: "bool",
		instructions: `First item, ${first.id}: ${first.text}\n\nSecond item, ${second.id}: ${second.text}\n\n${TEXTS.covers}`,
		criteria: { true: TEXTS.yes, false: TEXTS.no },
	};
}

const probabilityOf = (answer: Answer | undefined): number => (answer?.type === "bool" ? answer.probability : 0);

/** The search of one list as a state machine: the find step, the check step of the pairs it named, then done. */
export function searchMachine(list: List): StateMachine<SearchState> {
	const byId = new Map(list.items.map((item) => [item.id, item]));
	const itemOf = (id: string): Item => present(byId.get(id), `the item ${id}`);
	return {
		initial: () => Promise.resolve({ step: "find", candidates: [], checked: [] }),
		questions(state) {
			if (state.step === "find")
				return Object.fromEntries(
					list.items.map((item, index) => [findId(index), findQuestion(list, item, index).question]),
				);
			if (state.step === "check")
				return Object.fromEntries(
					state.candidates.flatMap((pair, index) => [
						[coversId(index, "ab"), coversQuestion(itemOf(pair.a), itemOf(pair.b))],
						[coversId(index, "ba"), coversQuestion(itemOf(pair.b), itemOf(pair.a))],
					]),
				);
			return {};
		},
		transition(state, answers) {
			if (state.step === "find") {
				const candidates = candidatesOf(list, answers);
				return Promise.resolve({ step: candidates.length > 0 ? "check" : "done", candidates, checked: [] });
			}
			const checked = state.candidates.map((pair, index) => ({
				...pair,
				aCoversB: probabilityOf(answers[coversId(index, "ab")]),
				bCoversA: probabilityOf(answers[coversId(index, "ba")]),
			}));
			return Promise.resolve({ ...state, step: "done", checked });
		},
		view: () => Promise.resolve(listView(list)),
	};
}

/** What the model reads in every step: the list's items by id, in their order. */
export const listView = (list: List): View => ({
	decisionState: { items: Object.fromEntries(list.items.map((item) => [item.id, item.text])) },
});

/**
 * What a checked pair is: a duplicate when each item covers the other, an overlap when one covers the other, and
 * separate when neither does.
 */
export function kindOf(pair: Checked): "duplicate" | "overlap" | "separate" {
	const ways = [pair.aCoversB, pair.bCoversA].filter((probability) => probability >= TEXTS.coversAt).length;
	return ways === 2 ? "duplicate" : ways === 1 ? "overlap" : "separate";
}

/** How a search ended: each checked pair with its kind, and the counts of each kind. */
export function outcomeOf(result: RunResult<SearchState>): JsonObject {
	const pairs = result.state.checked.map((pair) => ({ ...pair, kind: kindOf(pair) }));
	const count = (kind: string): number => pairs.filter((pair) => pair.kind === kind).length;
	return { duplicates: count("duplicate"), overlaps: count("overlap"), pairs };
}
