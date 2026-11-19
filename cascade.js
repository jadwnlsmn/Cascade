// Cascade's plan rules: the top model splits a task into steps and gives each to the cheapest model that can do it
// well. Steps run one by one, each as a subagent on its own model. Any model may add steps for its own level or
// lower. When the list is done, the top model checks the work and adds more or stops.
// The plan lives in CASCADE.md in the project, so you can read it and change a step's model by hand.
const fs = require("fs");
const path = require("path");

const DEFAULT_RANKING = ["opus", "sonnet", "haiku"];
const FILE = "CASCADE.md";
const TAG = "[Cascade] ";

// ---------- levels ----------

/** Level = places from the bottom of the ranking (best first). A model that isn't ranked counts as level 1. */
const levelOf = (plan, model) => (plan.ranking.includes(model) ? plan.ranking.length - plan.ranking.indexOf(model) : 0);
const modelAt = (plan, level) => plan.ranking[plan.ranking.length - level];
const levels = (plan) => plan.ranking.map((m, i) => `level ${plan.ranking.length - i}: ${m}`).join(", ");

/** A swap holds for the whole plan, steps added later included ("every sonnet step -> haiku"). */
function resolve(plan, model) {
  for (let i = 0; i < 10 && plan.swaps[model]; i++) model = plan.swaps[model];
  return model;
}

/** The step the plan counts from: the one running, or the last one before the review. */
function cur(plan) {
  if (plan.phase === "review") return plan.reviewFrom - 1;
  return plan.steps.findIndex((s) => s.running);
}

/** Who is calling the tools right now: the running step's model, or the top model while planning or reviewing. */
function caller(plan) {
  const i = cur(plan);
  return (plan.phase === "running" || plan.phase === "paused") && plan.steps[i] ? plan.steps[i].model : plan.ranking[0];
}

// ---------- changing the plan ----------

function newPlan(goal, ranking = DEFAULT_RANKING) {
  return { phase: "planning", goal: String(goal).trim(), ranking: [...ranking], swaps: {}, steps: [], addedThisTurn: 0, reviewFrom: 0 };
}

/** A model asks to add a step. Returns the answer it gets back. `by` is the model asking. */
function addStep(plan, by, args) {
  const task = String(args?.task || "").replace(/\s+/g, " ").trim();
  const level = Math.round(Number(args?.level));
  const mine = levelOf(plan, by) || 1;
  const n = plan.ranking.length;
  if (plan.phase === "done") return "Not added: the plan is finished. Start a new one with /cascade <task>.";
  if (!task) return "Not added: the step needs a task.";
  if (!(level >= 1 && level <= n)) return `Not added: levels go from 1 to ${n}.`;
  if (level > mine) return `Not added: you're level ${mine}, so you can give steps to level ${mine} or lower.`;
  const model = resolve(plan, modelAt(plan, level));
  // After the step running now (and after what this turn already added), or after the step number given,
  // but never in front of a step that's done or running.
  const first = cur(plan) + 1;
  let at = first + plan.addedThisTurn;
  const after = Math.round(Number(args?.after));
  if (args?.after !== undefined && args?.after !== null && Number.isFinite(after) && after >= 0) at = Math.max(first, Math.min(after, plan.steps.length));
  at = Math.min(at, plan.steps.length);
  plan.steps.splice(at, 0, { task, model, done: false, running: false, by, result: "" });
  plan.addedThisTurn++;
  return `Added as step ${at + 1}: "${task}" for level ${level} (${model}).`;
}

/** Change one step's model, or every step left on that model (and the ones added later). `number` is 1-based. */
function setModel(plan, number, to, all) {
  const step = plan.steps[number - 1];
  to = String(to || "").trim();
  if (!to || !step || step.done || step.model === to) return 0;
  if (!all) return (step.model = to, 1);
  const from = step.model;
  plan.swaps[from] = to;
  for (const k of Object.keys(plan.swaps)) if (plan.swaps[k] === from) plan.swaps[k] = to; // older swaps to it follow
  delete plan.swaps[to];
  let n = 0;
  for (const s of plan.steps) if (!s.done && s.model === from) (s.model = to, n++);
  return n;
}

/**
 * The main session finished a turn of the plan (planning, a step, or the review). Ticks the step and says what
 * runs next: { action: "step", number, model, prompt } | { action: "review", prompt } | { action: "paused" | "done", text }.
 * ok=false (the step failed) pauses the plan; the next call runs that step again.
 */
function next(plan, ok = true, result = "") {
  if (plan.phase === "done") return { action: "done", text: "This plan is finished. Start a new one with /cascade <task>." };
  const i = cur(plan);
  if (plan.phase === "running" && plan.steps[i]) {
    if (!ok) {
      plan.phase = "paused";
      return { action: "paused", text: `Paused on step ${i + 1}. Fix what went wrong, then /cascade start runs it again.` };
    }
    Object.assign(plan.steps[i], { done: true, running: false, result: String(result || "").replace(/\s+/g, " ").trim().slice(0, 500) });
  }
  if (plan.phase === "review" && plan.steps.length <= plan.reviewFrom) {
    plan.phase = "done";
    return { action: "done", text: "The review added nothing, so the plan is done." };
  }
  if (plan.phase === "planning" && !plan.steps.length) {
    plan.phase = "done";
    return { action: "done", text: "The planner added no steps." };
  }
  plan.addedThisTurn = 0;
  const j = plan.steps.findIndex((s) => !s.done);
  if (j >= 0) {
    plan.steps.forEach((s, k) => (s.running = k === j));
    plan.phase = "running";
    return { action: "step", number: j + 1, model: plan.steps[j].model, prompt: stepPrompt(plan, j) };
  }
  plan.phase = "review";
  plan.reviewFrom = plan.steps.length;
  return { action: "review", prompt: reviewPrompt(plan) };
}

// ---------- what each model is told ----------

function planPrompt(plan) {
  return `${TAG}You are the planner: level ${plan.ranking.length}, the top model. The models are ${levels(plan)}. ` +
    "Don't do the task yet. Split it into steps and add each one, in order, with the cascade_add_step tool. Give every step to the lowest level that can do it well: " +
    "design and tricky code high, reading files, renaming, boilerplate and simple edits low. Each step runs later as a subagent on its model. " +
    "A subagent doesn't see this chat: it gets the plan, the results of earlier steps and the project files, so write every task so it can be done from those alone. " +
    "Make the last step a check of the whole result only if it needs one; you'll review everything at the end anyway. Then reply with one short line.\n\nThe task:\n" + plan.goal;
}

function stepPrompt(plan, i) {
  const s = plan.steps[i];
  const lvl = levelOf(plan, s.model) || 1;
  const list = plan.steps.map((x, k) => `${k + 1}. ${x.done ? "[done] " : k === i ? "[you] " : ""}${x.task}${x.result ? `\n   Result: ${x.result}` : ""}`).join("\n");
  return `${TAG}You're in Cascade: a plan of steps for one task, each done by a different model. You are level ${lvl} (${s.model}); the models are ${levels(plan)}.\n\n` +
    `The whole task:\n${plan.goal}\n\nThe plan:\n${list}\n\nDo ONLY step ${i + 1}: ${s.task}\n\n` +
    `Don't do other steps. If you find work that's needed, add it with the cascade_add_step tool (level ${lvl} or lower). ` +
    "Don't call the other cascade tools; the main session runs the plan. When you're done, reply with a short summary of what you did, for the steps after you.";
}

function reviewPrompt(plan) {
  const list = plan.steps.map((x, k) => `${k + 1}. ${x.task} (${x.model})${x.result ? `\n   Result: ${x.result}` : ""}`).join("\n");
  return `${TAG}Every step of the Cascade plan is done:\n${list}\n\nThe task was:\n${plan.goal}\n\n` +
    "Check the work against the task (look at the files, run what needs running). If anything is missing or wrong, add steps with cascade_add_step. " +
    "If it's finished, add nothing. Then call cascade_next.";
}

// ---------- CASCADE.md ----------

function toMarkdown(plan) {
  const swaps = Object.entries(plan.swaps).map(([a, b]) => `${a} -> ${b}`).join(", ") || "none";
  const steps = plan.steps.map((s, k) => {
    const box = s.done ? "x" : s.running ? ">" : " ";
    const by = s.by && s.by !== plan.ranking[0] ? ` (added by ${s.by})` : "";
    return `- [${box}] ${k + 1}. ${s.task} @${s.model}${by}${s.result ? `\n  Result: ${s.result}` : ""}`;
  }).join("\n");
  return "# Cascade plan\n\n" +
    "Change a step's model by editing the word after @ on a step that isn't done, or with /cascade:cascade swap.\n\n" +
    `Phase: ${plan.phase}\nRanking: ${plan.ranking.join(" > ")}\nSwaps: ${swaps}\nAdded this turn: ${plan.addedThisTurn}\nReview from: ${plan.reviewFrom}\n\n` +
    `## Goal\n\n${plan.goal}\n\n## Steps\n\n${steps || "(none yet)"}\n`;
}

const STEP = /^- \[([ x>])\] \d+\. (.+) @(\S+)(?: \(added by (\S+)\))?$/;

function fromMarkdown(text) {
  text = String(text).replace(/\r\n/g, "\n");
  const field = (name) => (text.match(new RegExp(`^${name}: (.*)$`, "m")) || [])[1]?.trim() || "";
  const ranking = field("Ranking").split(">").map((m) => m.trim()).filter(Boolean);
  const swaps = {};
  for (const pair of field("Swaps").split(",")) {
    const [a, b] = pair.split("->").map((m) => m.trim());
    if (a && b) swaps[a] = b;
  }
  const goal = (text.match(/## Goal\n\n([\s\S]*?)\n\n## Steps/) || [])[1] || "";
  const steps = [];
  for (const line of (text.split("## Steps")[1] || "").split("\n")) {
    const m = line.match(STEP);
    if (m) steps.push({ task: m[2], model: m[3], done: m[1] === "x", running: m[1] === ">", by: m[4] || "", result: "" });
    else if (steps.length && /^\s+Result: /.test(line)) steps[steps.length - 1].result = line.replace(/^\s+Result: /, "").trim();
  }
  return {
    phase: field("Phase") || "planning", goal, ranking: ranking.length ? ranking : [...DEFAULT_RANKING], swaps, steps,
    addedThisTurn: Number(field("Added this turn")) || 0, reviewFrom: Number(field("Review from")) || 0
  };
}

const planFile = (dir) => path.join(dir, FILE);
function load(dir) {
  try { return fromMarkdown(fs.readFileSync(planFile(dir), "utf8")); } catch { return null; }
}
const save = (dir, plan) => fs.writeFileSync(planFile(dir), toMarkdown(plan));

module.exports = { DEFAULT_RANKING, FILE, levelOf, caller, newPlan, addStep, setModel, next, planPrompt, toMarkdown, fromMarkdown, load, save };
