import {
	type Answers,
	choiceType,
	type DomainShared,
	joinTypes,
	type JsonObject,
	picking,
	type Questions,
	type RunResult,
	type StateMachine,
} from "@osolmaz/switch";
import type { JudgeCase } from "./case.ts";
import { changes } from "./choices/changes.ts";
import { compare } from "./choices/compare.ts";
import { count } from "./choices/count.ts";
import { look } from "./choices/look.ts";
import { read } from "./choices/read.ts";
import { search } from "./choices/search.ts";
import { itemQuestions, type Judge, type JudgeDefinition } from "./definition.ts";
import { verdictsFrom } from "./judge.ts";
import { openAnswer } from "./start.ts";
import type { CaseFolder, JudgeState } from "./state.ts";
import { searchTerms } from "./terms.ts";
import { view } from "./view.ts";

/** The version of this domain's code. A run records the judge apart, as its definition with its hash. */
export const CODE_VERSION = "0.8.0";

/**
 * What every case shares under a judge: the domain's name and version, and the share of the window that a request may
 * fill. The judge's own limit on gathering steps ends every run, so the run needs no step limit of switch's.
 */
export function rubricJudge({ definition }: Judge): DomainShared {
	return { name: "rubric-judge", version: CODE_VERSION, limits: { windowShare: definition.limits.windowShare } };
}

/** Stop gathering evidence: always among the choices while the model gathers, and never cut. */
const stopGathering = (text: string) =>
	choiceType<JudgeState, null>({
		type: "stop",
		choices: () => [{ key: "stop", text, arg: null, priority: -1 }],
		transition: (state) => ({ ...state, gathered: true }),
	});

/** The probability of yes of each bool answer, by the question's id. */
const yesOf = (answers: Answers): Record<string, number> =>
	Object.fromEntries(
		Object.entries(answers).flatMap(([id, answer]) => (answer.type === "bool" ? [[id, answer.probability]] : [])),
	);

/**
 * One pass of gathering and checks over the rubric items in `focus.items`: the case with only those items, the gathering
 * choices and pick that they drive, and their checks.
 */
interface Pass {
	readonly focus: JudgeCase;
	readonly pick: Pick<StateMachine<JudgeState>, "questions" | "transition">;
	readonly checks: Questions;
	/** Whether the pass gathered enough: the model stopped, the judge's step limit, or nothing left to gather but stop. */
	readonly checking: (state: JudgeState) => boolean;
}

function passOver(definition: JudgeDefinition, focus: JudgeCase): Pass {
	const { texts, limits } = definition;
	const gathering = joinTypes(
		read(focus),
		look(focus),
		search(focus, searchTerms(focus)),
		count(focus),
		changes(focus),
		compare(focus),
		stopGathering(texts.stop),
	);
	const pick = picking({
		instructions: `${texts.gather} ${texts.choose}`,
		limit: limits.choices,
		choices: gathering.choices,
		transition: async (state: JudgeState, choice) => {
			const next = await gathering.transition(state, choice);
			const steps = state.steps + 1;
			return { ...next, steps, gathered: next.gathered || steps >= limits.steps };
		},
	});
	const checks = Object.fromEntries(focus.items.flatMap((item) => itemQuestions(definition, item)));
	// Stop alone is no pick worth a request: the checks follow at once.
	const onlyStop = (state: JudgeState) => gathering.choices(state).every((choice) => choice.type === "stop");
	const checking = (state: JudgeState) => state.gathered || state.steps >= limits.steps || onlyStop(state);
	return { focus, pick, checks, checking };
}

/**
 * The passes of a case under the judge's scope: one over the whole rubric, or one for each rubric item, so that no
 * request about an item shows another item.
 */
const passesOf = (definition: JudgeDefinition, judgeCase: JudgeCase): Pass[] =>
	definition.scope === "item"
		? judgeCase.items.map((item) => passOver(definition, { ...judgeCase, items: [item] }))
		: [passOver(definition, judgeCase)];

/**
 * The state machine of one case. A pass gathers evidence with one pick in each state, until the model picks stop, takes
 * as many steps as the judge allows, or has nothing left to gather. Then one step asks the judge's questions about the
 * pass's rubric items. A judge of rubric scope makes one pass over every item; a judge of item scope makes one pass for
 * each item in turn, each from the answer opened afresh, and keeps every pass's answers. After the last pass the run is
 * over: the outcome joins each item's answers into its verdict.
 *
 * The state says when gathering is over, also at the judge's limit, so that a fork of the state before the checks
 * under another judge, with another limit, asks only the checks again.
 */
export function judgeMachine(definition: JudgeDefinition, folder: CaseFolder): StateMachine<JudgeState> {
	const judgeCase = folder.case;
	const passes = passesOf(definition, judgeCase);
	const [first] = passes;
	if (first === undefined) throw new Error(`case ${judgeCase.id} has no rubric items`);
	// A state of rubric scope has no `pass`, as before item scope existed; one of item scope numbers its pass.
	const opened = (pass: number): JudgeState =>
		definition.scope === "item" ? { ...openAnswer(judgeCase), pass } : openAnswer(judgeCase);
	const passOf = (state: JudgeState): Pass => passes[state.pass ?? 0] ?? first;
	/**
	 * Whether the run is over: in rubric scope once the one pass has its answers; in item scope once the pass number is
	 * past the last pass, which the last pass's checks set.
	 */
	const finished = (state: JudgeState): boolean =>
		state.checks !== null && (state.pass === undefined || state.pass >= passes.length);
	/** The state after a pass's checks: the next pass from the answer opened afresh, keeping the answers so far. */
	const afterChecks = (state: JudgeState, answers: Answers): JudgeState => {
		const checks = { ...state.checks, ...yesOf(answers) };
		if (state.pass === undefined) return { ...state, checks };
		const next = state.pass + 1;
		return next < passes.length ? { ...opened(next), checks } : { ...state, checks, pass: next };
	};
	return {
		initial: () => Promise.resolve(opened(0)),
		questions: (state) => {
			if (finished(state)) return {};
			const pass = passOf(state);
			return pass.checking(state) ? pass.checks : pass.pick.questions(state);
		},
		transition: (state, answers) => {
			const pass = passOf(state);
			return pass.checking(state)
				? Promise.resolve(afterChecks(state, answers))
				: pass.pick.transition(state, answers);
		},
		view: (state, tokens, charsPerToken) => {
			const pass = passOf(state);
			const of = { texts: definition.texts, folder, focus: pass.focus };
			return view(of, state, pass.checking(state), tokens, charsPerToken);
		},
	};
}

/**
 * How a case ended under `definition`: each rubric item's probability of passing, by the item's id. The verdicts are
 * null when the run ended before the checks, such as when a request failed.
 */
export const judgeOutcome =
	(definition: JudgeDefinition) =>
	({ state }: Pick<RunResult<JudgeState>, "state">): JsonObject => ({
		verdicts: state.checks === null ? null : verdictsFrom(definition, state.checks),
	});

export { type JudgeCase, caseSchema } from "./case.ts";
export { DEFAULT_JUDGE, type Judge, type JudgeDefinition, judgeOf, loadJudge } from "./definition.ts";
export type { CaseFolder, Evidence, JudgeState } from "./state.ts";
