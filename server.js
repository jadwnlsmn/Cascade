// Cascade's MCP server (stdio, no dependencies). Keeps the plan in CASCADE.md in the project and enforces the rules:
// a model may add steps only for its own level or lower, swaps hold for the whole plan, finished steps never change.
// Claude Code starts it from the plugin's .mcp.json.
const c = require("./cascade.js");

const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const NO_PLAN = `There's no Cascade plan here (${c.FILE}). Start one with /cascade:cascade <task>.`;

const TOOLS = [
  {
    name: "cascade_new",
    description: "Start a Cascade plan for a task. Only the main session calls this, from the /cascade:cascade skill. Returns the planning instructions.",
    inputSchema: { type: "object", properties: {
      goal: { type: "string", description: "The user's task, in their words" },
      replace: { type: "boolean", description: "Start over even if a plan is still open" }
    }, required: ["goal"] }
  },
  {
    name: "cascade_add_step",
    description: "Add a step to the Cascade plan. Each step is done later by the model of the level you give. You may only give a step to your own level or a lower one. Write the task so that model can do it alone.",
    inputSchema: { type: "object", properties: {
      task: { type: "string", description: "One clear instruction for the model that does this step" },
      level: { type: "integer", description: "Which level does it: the lowest level that can do it well" },
      after: { type: "integer", description: "Optional: the step number to put it after. Default: after the steps you already added this turn" }
    }, required: ["task", "level"] }
  },
  {
    name: "cascade_next",
    description: "Main session only: say the current turn of the plan is over (planning, a step, or the review) and get what runs next.",
    inputSchema: { type: "object", properties: {
      ok: { type: "boolean", description: "false if the step failed; the plan pauses on it. Default true" },
      result: { type: "string", description: "The step's short summary, passed on to the steps after it" }
    } }
  },
  {
    name: "cascade_swap",
    description: "Change the model of a step that isn't done. all=true changes every step left on that step's model, and the ones added later.",
    inputSchema: { type: "object", properties: {
      step: { type: "integer", description: "The step number" },
      model: { type: "string", description: "The new model (opus, sonnet, haiku or fable)" },
      all: { type: "boolean", description: "Every step on that model, not just this one" }
    }, required: ["step", "model"] }
  },
  {
    name: "cascade_rank",
    description: "Set the model ranking, best first. The top one plans and reviews; each model can hand work to the ones below it.",
    inputSchema: { type: "object", properties: { models: { type: "array", items: { type: "string" }, description: "Models, best first" } }, required: ["models"] }
  }
];

function call(name, a = {}) {
  const plan = c.load(dir);
  if (name === "cascade_new") {
    if (plan && plan.phase !== "done" && !a.replace) return `A plan is still open (${plan.phase}) in ${c.FILE}. Pass replace: true to start over.`;
    const p = c.newPlan(a.goal, plan?.ranking);
    if (!p.goal) return "The plan needs a goal.";
    c.save(dir, p);
    return c.planPrompt(p);
  }
  if (!plan) return NO_PLAN;
  let text;
  if (name === "cascade_add_step") text = c.addStep(plan, c.caller(plan), a);
  else if (name === "cascade_swap") {
    const n = c.setModel(plan, Math.round(Number(a.step)), a.model, Boolean(a.all));
    text = n ? `${n} step${n > 1 ? "s" : ""} now use ${a.model}${a.all ? ", and so will steps added later" : ""}.` : "Nothing changed: that step is done, doesn't exist, or already uses that model.";
  } else if (name === "cascade_rank") {
    const models = (a.models || []).map((m) => String(m).trim()).filter(Boolean);
    if (!models.length) return "The ranking needs at least one model.";
    plan.ranking = models;
    text = `Ranking: ${models.map((m, i) => `level ${models.length - i}: ${m}`).join(", ")}.`;
  } else if (name === "cascade_next") {
    const r = c.next(plan, a.ok !== false, a.result);
    text = r.action === "step"
      ? `Run step ${r.number} now: call the Agent tool with model "${r.model}" and exactly this prompt. When it returns, call cascade_next with ok and its summary as result.\n\n${r.prompt}`
      : r.action === "review" ? `All steps are done. Review the work yourself, not in a subagent:\n\n${r.prompt}` : r.text;
  } else return `Unknown tool ${name}.`;
  c.save(dir, plan);
  return text;
}

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue; // notifications need no answer
    if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: m.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "cascade", version: "1.0.0" } } });
    else if (m.method === "tools/list") send({ id: m.id, result: { tools: TOOLS } });
    else if (m.method === "tools/call") {
      let text;
      try { text = call(m.params?.name, m.params?.arguments || {}); } catch (e) { text = `Cascade failed: ${e.message}`; }
      send({ id: m.id, result: { content: [{ type: "text", text }] } });
    } else if (m.method === "ping") send({ id: m.id, result: {} });
    else send({ id: m.id, error: { code: -32601, message: `Unknown method ${m.method}` } });
  }
});
