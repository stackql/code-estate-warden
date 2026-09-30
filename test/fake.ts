// A runtime that spends nothing: it runs a scripted list of tool calls, then returns a canned reply.

import type { AgentRuntime, Ask } from "../src/agent.ts";

export interface Step {
  tool: string;
  args: unknown;
}

export class FakeRuntime implements AgentRuntime {
  readonly prompts: string[] = [];
  readonly results: unknown[] = [];

  private readonly reply: unknown;
  private readonly script: Step[];

  constructor(reply: unknown, script: Step[] = []) {
    this.reply = reply;
    this.script = script;
  }

  async ask<T>({ prompt, tools, schema }: Ask<T>): Promise<T> {
    this.prompts.push(prompt);
    for (const step of this.script) {
      const tool = tools.find((t) => t.name === step.tool);
      if (!tool) throw new Error(`no tool ${step.tool}`);
      this.results.push(await tool.handler(tool.parameters.parse(step.args)));
    }
    return schema.parse(this.reply);
  }
}
