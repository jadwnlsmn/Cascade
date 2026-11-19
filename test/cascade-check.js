// Self-check for Cascade's plan rules: levels, inserting steps, swaps for the whole plan, the step loop, CASCADE.md.
//   node test/cascade-check.js
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const c = require("../cascade.js");

// the file round-trips at every point, so a plan survives between tool calls and hand edits
const trip = (p) => c.fromMarkdown(c.toMarkdown(p));

let plan = c.newPlan("build an app");
assert.deepStrictEqual(plan.ranking, ["opus", "sonnet", "haiku"], "default ranking: Opus, Sonnet, Haiku");
assert.strictEqual(c.levelOf(plan, "opus"), 3, "top model is the highest level");
assert.match(c.planPrompt(plan), /Don't do the task yet/, "the top model gets the planning prompt");

// planning: steps go in order, and a model can't hand work above its level
const add = (by, task, level, after) => c.addStep(plan, by, { task, level, after });
add("opus", "scan files", 2);
add("opus", "write code", 3);
add("opus", "rename file", 1);
plan = trip(plan);
assert.deepStrictEqual(plan.steps.map((s) => s.task), ["scan files", "write code", "rename file"], "planner's steps keep their order");
assert.match(add("sonnet", "too hard", 3), /Not added: you're level 2/, "a level-2 model can't give work to level 3");
assert.match(add("opus", "x", 4), /levels go from 1 to 3/);
assert.strictEqual(plan.steps.length, 3);
assert.strictEqual(c.caller(plan), "opus", "while planning, the caller is the top model");

// a swap of every sonnet step holds for steps added later; finished steps keep theirs
plan.steps[0].done = true;
assert.strictEqual(c.setModel(plan, 1, "qwen", true), 0, "a finished step can't be changed");
plan.steps[0].done = false;
assert.strictEqual(c.setModel(plan, 1, "qwen", true), 1, "every sonnet step left is swapped");
plan = trip(plan);
assert.deepStrictEqual(plan.swaps, { sonnet: "qwen" }, "the swap is kept in the file");
add("opus", "tests", 2);
assert.strictEqual(plan.steps[3].model, "qwen", "a sonnet step added later goes to the swapped model");
assert.strictEqual(c.setModel(plan, 3, "sonnet", false), 1, "one step can change alone");
assert.strictEqual(plan.steps[1].model, "opus", "other steps are untouched");

// the loop: start runs step 1; steps a model adds go right after its own step
plan = trip(plan);
let r = c.next(plan);
assert.strictEqual(r.action, "step");
assert.strictEqual(r.model, "qwen", "step 1 runs on its model");
assert.match(r.prompt, /Do ONLY step 1: scan files/);
plan = trip(plan);
assert.strictEqual(c.caller(plan), "qwen", "during a step, the caller is that step's model");
assert.match(c.addStep(plan, c.caller(plan), { task: "fix typo", level: 1 }), /Added as step 2/);
assert.strictEqual(plan.steps[1].task, "fix typo", "a step added during step 1 goes right after it");
assert.match(c.addStep(plan, c.caller(plan), { task: "big redesign", level: 2 }), /you're level 1/, "an unranked (swapped-in) model counts as level 1");

// a failed step pauses, and the next call runs the same step again
r = c.next(plan, false);
assert.strictEqual(r.action, "paused");
r = c.next(trip(plan));
plan = trip(plan);
r = c.next(plan);
assert.strictEqual(r.number, 1, "after a pause the same step runs again");
r = c.next(plan, true, "found 12 files");
assert.strictEqual(r.number, 2);
assert.match(r.prompt, /Result: found 12 files/, "later steps see earlier results");
plan = trip(plan);
assert.strictEqual(plan.steps[0].result, "found 12 files", "results are kept in the file");

for (let i = 0; i < 10 && r.action === "step"; i++) { plan = trip(plan); r = c.next(plan); }
assert.ok(plan.steps.every((s) => s.done), "every step is ticked");
assert.strictEqual(r.action, "review", "the top model reviews at the end");
assert.match(r.prompt, /Every step of the Cascade plan is done/);

// the review can add steps; they run, then it reviews again; a review that adds nothing ends the plan
plan = trip(plan);
assert.strictEqual(c.caller(plan), "opus");
c.addStep(plan, "opus", { task: "add docs", level: 1 });
c.addStep(plan, "opus", { task: "add license", level: 1 });
assert.deepStrictEqual(plan.steps.slice(-2).map((s) => s.task), ["add docs", "add license"], "review steps go at the end, in order");
r = c.next(trip(plan));
plan = trip(plan);
r = c.next(plan);
assert.strictEqual(r.action, "step");
assert.match(r.prompt, /Do ONLY step \d+: add docs/);
r = c.next(plan);
r = c.next(plan);
assert.strictEqual(r.action, "review");
r = c.next(trip(plan));
assert.strictEqual(r.action, "done", "a review that adds nothing ends the plan");

// a hand edit of a step's model is read back
const edited = c.toMarkdown(c.fromMarkdown(c.toMarkdown(plan))).replace("add license @haiku", "add license @sonnet");
assert.strictEqual(c.fromMarkdown(edited).steps.at(-1).model, "sonnet", "editing the @model in CASCADE.md changes the step");

// save and load use CASCADE.md in the folder
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cascade-"));
assert.strictEqual(c.load(dir), null, "no file, no plan");
c.save(dir, plan);
assert.deepStrictEqual(c.load(dir), trip(plan));
fs.rmSync(dir, { recursive: true });

console.log("cascade: ok");
