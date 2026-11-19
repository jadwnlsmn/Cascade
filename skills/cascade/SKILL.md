---
name: cascade
description: Cascade plans a task into steps and runs each step as a subagent on the cheapest model that can do it well (Opus plans and reviews, Sonnet and Haiku do the steps).
when_to_use: When the user asks to cascade a task, run it across models, hand steps to cheaper models, or start, swap, rank or check a Cascade plan (CASCADE.md). Pass the task, or start / swap / rank / status, as the arguments.
argument-hint: "<task> | start | swap <step> <model> [all] | rank <model> <model> ... | status"
allowed-tools: mcp__plugin_cascade_cascade__cascade_new mcp__plugin_cascade_cascade__cascade_add_step mcp__plugin_cascade_cascade__cascade_next mcp__plugin_cascade_cascade__cascade_swap mcp__plugin_cascade_cascade__cascade_rank Read(CASCADE.md)
---

# Cascade

You are the main session and the top model of Cascade. The plan lives in `CASCADE.md` in the project; the
`cascade_*` tools (server `cascade`) keep it and enforce its rules. Never edit `CASCADE.md` yourself.

The request: `$ARGUMENTS`

You may be here because the user typed `/cascade:cascade`, or because you chose this skill for their request.
Either way, the steps are the same.

Pick the mode from the first word:

- **`start`** (or `continue`): run the plan, as in "Running the plan" below.
- **`swap <step> <model> [all]`**: call `cascade_swap` with that step number and model; `all` sets `all: true`
  (every step left on that step's model, and steps added later). Show the answer and the updated `CASCADE.md` steps.
- **`rank <model> <model> ...`**: call `cascade_rank` with the models, best first. Show the answer.
- **`status`**: read `CASCADE.md` and show the steps in short.
- **Anything else is a new task.** Call `cascade_new` with the whole text as `goal`. If it says a plan is still
  open, ask the user whether to replace it (then call again with `replace: true`) or to `start` the open one.
  Then follow the instructions it returns: add the steps with `cascade_add_step`, in order. Don't do the task.
  Finish by showing the plan (read `CASCADE.md`) as a short numbered list with each step's model, and tell the
  user they can change models with `/cascade:cascade swap <step> <model> [all]` or by editing the word after
  `@` in `CASCADE.md`, then run it with `/cascade:cascade start`. Stop there, unless the user asked for the
  task to run straight away (for example "cascade this and run it"): then go on to "Running the plan".

## Running the plan

Loop until `cascade_next` says the plan is done or paused:

1. Call `cascade_next`. On the first call after planning, call it with no arguments.
2. If it says **run step N**: call the Agent tool (subagent type `general-purpose`) with the model it names
   and exactly the prompt it gives. Don't add to the prompt or do the step yourself. When the subagent
   returns, call `cascade_next` with `ok: true` and `result` set to the subagent's summary in one or two
   sentences. If the subagent failed or couldn't do the step, call it with `ok: false` instead, tell the user
   what went wrong, and stop.
3. If it says **review**: do the review yourself (you are the top model). Look at the files, run what needs
   running. Add steps with `cascade_add_step` if anything is missing or wrong. Then call `cascade_next`.
4. Between steps, tell the user one short line: which step finished and on which model.

When it's done, give the user a short summary of what was built and which models did which steps.

The Agent tool's `model` takes only `opus`, `sonnet`, `haiku` or `fable`. If a step names any other model,
don't run it: tell the user to swap that step to one of those, and stop.
