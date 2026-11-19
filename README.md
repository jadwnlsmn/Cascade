<p align="center"><img src="assets/logo.png" alt="Cascade logo" width="128"></p>

# Cascade

Cascade saves credits by splitting a task into steps and giving each step to the cheapest model that can do it
well. The top model (Opus) plans and reviews. Cheaper models (Sonnet, Haiku) do the steps, each as a subagent.

1. You give a task. The top model splits it into steps and gives each one a level.
2. You check the plan in `CASCADE.md` and change any step's model if you like.
3. The steps run one by one, each as a subagent on its own model. A step's short result is passed on to the
   steps after it.
4. While working, any model may add steps, but only for its own level or lower.
5. When every step is done, the top model reviews the work. It either adds more steps (which then run) or
   ends the plan.

## Install

Requires Node.js (no npm packages).

```
claude plugin marketplace add jadwnlsmn/Cascade
claude plugin install cascade@cascade
```

Or inside Claude Code: `/plugin marketplace add jadwnlsmn/Cascade`, then `/plugin install cascade@cascade`.

To try it without installing, clone this repo and start Claude Code with `claude --plugin-dir <path to the clone>`.

## Use

Run the main session on your top model (Opus by default): it plans and reviews. You can type the commands below, or just ask Claude to cascade a task and it starts the skill itself.

| Command | What it does |
| --- | --- |
| `/cascade:cascade <task>` | Plan the task. Nothing runs yet. |
| `/cascade:cascade start` | Run the plan (also resumes a paused one). |
| `/cascade:cascade swap <step> <model>` | Change one step's model. |
| `/cascade:cascade swap <step> <model> all` | Change every step left on that step's model, and steps added later. |
| `/cascade:cascade rank opus sonnet haiku` | Set the ranking, best first. |
| `/cascade:cascade status` | Show the plan. |

You can also change a step's model by editing the word after `@` in `CASCADE.md`. Steps that are done never
change. If a step fails, the plan pauses on it, and `start` runs that step again.

## The ranking

The ranking lists the models best first. The default is `opus > sonnet > haiku`. A model's level is its place
counted from the bottom: with the default, Haiku is level 1, Sonnet is level 2 and Opus is level 3.

- The top model plans and reviews.
- A model can give steps only to its own level or lower. The MCP server enforces this.
- A model that isn't in the ranking (for example, one you swapped in) counts as level 1.
- A new plan keeps the ranking of the last plan in the same project.

Subagents only take `opus`, `sonnet`, `haiku` or `fable`, so use those names in the ranking and in swaps.

## How it works

| File | What it does |
| --- | --- |
| `skills/cascade/SKILL.md` | The `/cascade:cascade` command. It tells the main session how to plan and run the loop. |
| `server.js` | A small stdio MCP server, started from `.mcp.json`. Its tools are `cascade_new`, `cascade_add_step`, `cascade_next`, `cascade_swap` and `cascade_rank`. It keeps the plan in `CASCADE.md` in the project. |
| `cascade.js` | The plan rules: levels, where new steps go, swaps, the step loop, the prompts each model gets, and reading and writing `CASCADE.md`. |

The server knows who is calling from the plan itself. While a step runs, the caller is that step's model. While
the plan is being made or reviewed, the caller is the top model.

## Test

```
node test/cascade-check.js
```

## Limits

- Subagents don't see the main chat. A step gets the task, the plan, earlier steps' results and the project
  files, so the planner has to write self-contained tasks.
- Subagents can see every `cascade_*` tool. Their prompt tells them to use only `cascade_add_step`, but
  nothing stops one calling another tool.
- Steps run one at a time.

## License

Apache License 2.0. See `LICENSE` and `NOTICE`.
