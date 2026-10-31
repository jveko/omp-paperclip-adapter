import { promises as fs } from "node:fs";
import path from "node:path";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import {
  DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE,
  joinPromptSections,
  renderPaperclipWakePrompt,
  renderTemplate,
  selectPaperclipTaskMarkdown,
} from "@paperclipai/adapter-utils/server-utils";

/**
 * The run's prompt.
 *
 * The supervisor sends the text over the socket, so the shape is built here
 * from Paperclip's own exported building blocks (template, wake prompt, task
 * markdown, session handoff). The order and joining mirror what an ACP client
 * builds; anything that changes here changes what an employee sees.
 *
 * A "Paperclip API access" note is deliberately absent: the run JWT stays out
 * of the worker env, so teaching curl with `$PAPERCLIP_API_KEY` would describe
 * a variable that is not there. Only the runtime note listing the PAPERCLIP_*
 * keys actually present is rendered.
 */

export interface ManagedPromptInput {
  ctx: AdapterExecutionContext;
  instructionsFilePath: string | null;
  resumedSession: boolean;
  /** The env the worker will actually see (stable vars only). */
  env: Record<string, string>;
  onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
}

export interface ManagedPrompt {
  prompt: string;
  commandNotes: string[];
  promptMetrics: Record<string, number>;
}

function renderPaperclipEnvNote(env: Record<string, string>): string {
  const keys = Object.keys(env).filter((key) => key.startsWith("PAPERCLIP_")).sort();
  if (keys.length === 0) return "";
  return [
    "Paperclip runtime note:",
    `The following PAPERCLIP_* environment variables are available in this run: ${keys.join(", ")}`,
    "Do not assume these variables are missing without checking your shell environment.",
  ].join("\n");
}

export async function buildManagedPrompt(input: ManagedPromptInput): Promise<ManagedPrompt> {
  const { ctx } = input;
  const promptTemplate = typeof ctx.config.promptTemplate === "string" && ctx.config.promptTemplate.trim() !== ""
    ? ctx.config.promptTemplate
    : DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE;
  const commandNotes: string[] = [];
  let instructionsPrefix = "";
  if (input.instructionsFilePath !== null) {
    try {
      const contents = await fs.readFile(input.instructionsFilePath, "utf8");
      const dir = `${path.dirname(input.instructionsFilePath)}/`;
      instructionsPrefix = `${contents}\n\n`
        + `The above agent instructions were loaded from ${input.instructionsFilePath}. `
        + `Resolve any relative file references from ${dir}.\n\n`;
      commandNotes.push(
        `Loaded agent instructions from ${input.instructionsFilePath}`,
        `Prepended instructions + path directive to the prompt (relative references from ${dir}).`,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await input.onLog("stderr", `[paperclip] Warning: could not read agent instructions file "${input.instructionsFilePath}": ${reason}\n`);
      commandNotes.push(`Configured instructionsFilePath ${input.instructionsFilePath}, but file could not be read.`);
    }
  }

  const bootstrapPromptTemplate = typeof ctx.config.bootstrapPromptTemplate === "string"
    ? ctx.config.bootstrapPromptTemplate
    : "";
  const templateData = {
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    runId: ctx.runId,
    company: { id: ctx.agent.companyId },
    agent: ctx.agent,
    run: { id: ctx.runId, source: "on_demand" },
    context: ctx.context,
  };
  const renderedBootstrapPrompt = !input.resumedSession && bootstrapPromptTemplate.trim().length > 0
    ? renderTemplate(bootstrapPromptTemplate, templateData).trim()
    : "";
  const taskContextNote = selectPaperclipTaskMarkdown(ctx.context, { resumedSession: input.resumedSession });
  const wakePrompt = renderPaperclipWakePrompt(ctx.context.paperclipWake, {
    resumedSession: input.resumedSession,
    suppressIssueDescription: taskContextNote.length > 0,
  });
  const shouldUseResumeDeltaPrompt = input.resumedSession && wakePrompt.length > 0;
  const promptInstructionsPrefix = shouldUseResumeDeltaPrompt ? "" : instructionsPrefix;
  const renderedPrompt = shouldUseResumeDeltaPrompt ? "" : renderTemplate(promptTemplate, templateData);
  const sessionHandoffNote = typeof ctx.context.paperclipSessionHandoffMarkdown === "string"
    ? ctx.context.paperclipSessionHandoffMarkdown.trim()
    : "";
  const paperclipEnvNote = renderPaperclipEnvNote(input.env);
  const prompt = joinPromptSections([
    promptInstructionsPrefix,
    renderedBootstrapPrompt,
    wakePrompt,
    sessionHandoffNote,
    taskContextNote,
    paperclipEnvNote,
    renderedPrompt,
  ]);
  return {
    prompt,
    commandNotes,
    promptMetrics: {
      promptChars: prompt.length,
      instructionsChars: promptInstructionsPrefix.length,
      bootstrapPromptChars: renderedBootstrapPrompt.length,
      wakePromptChars: wakePrompt.length,
      sessionHandoffChars: sessionHandoffNote.length,
      taskContextChars: taskContextNote.length,
      runtimeNoteChars: paperclipEnvNote.length,
      heartbeatPromptChars: renderedPrompt.length,
    },
  };
}
