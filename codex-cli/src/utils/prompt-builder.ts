import type { AppConfig } from "./config.js";
import type { OpenAI } from "openai";
import type { ResponseItem } from "openai/resources/responses/responses";

import { generateCompactSummary } from "./compact-summary.js";
import { countPromptTokens } from "./token-metering.js";

interface TextPart {
  type?: string;
  text?: string;
}

export interface PromptBuilderOptions {
  maxTokens?: number;
  keepMessages?: number;
  maxPatchLines?: number;
  model?: string;
  flexMode?: boolean;
  config?: AppConfig;
}

export class PromptBuilder {
  private maxTokens: number;
  private keepMessages: number;
  private summaryBacklog: Array<string> = [];
  private model: string;
  private flexMode: boolean;
  private config?: AppConfig;
  private history: Array<ResponseItem> = [];

  constructor(opts: PromptBuilderOptions = {}) {
    this.maxTokens = opts.maxTokens ?? 6000;
    this.keepMessages = opts.keepMessages ?? 6;
    this.model = opts.model ?? "gpt-4.1";
    this.flexMode = Boolean(opts.flexMode);
    this.config = opts.config;
  }

  push(item: ResponseItem): void {
    this.history.push(item);
  }


  private count(messages: Array<ResponseItem>): number {
    return countPromptTokens(
      messages.map((m) => {
        if (m.type === "message" && typeof (m as { role?: string }).role === "string") {
          const role = (m as { role: string }).role;
          const content = Array.isArray(m.content)
            ? (m.content as Array<TextPart>).map((p) => p.text || "").join("")
            : typeof m.content === "string"
              ? m.content
              : "";
          return { role, content };
        }
        return { role: "system", content: "" };
      }) as unknown as Array<OpenAI.Chat.Completions.ChatCompletionMessageParam>,
    );
  }

  private async summarizeOld(items: Array<ResponseItem>): Promise<void> {
    if (!items.length) {
      return;
    }
    const summary = await generateCompactSummary(
      items,
      this.model,
      this.flexMode,
      this.config as AppConfig,
    );
    this.summaryBacklog.push(summary);
  }

  async build(): Promise<Array<ResponseItem>> {
    const keep = this.history.slice(-this.keepMessages);
    if (this.history.length > this.keepMessages) {
      const old = this.history.slice(0, -this.keepMessages);
      await this.summarizeOld(old);
    }
    const result: Array<ResponseItem> = [];
    if (this.summaryBacklog.length) {
      result.push({
        type: "message",
        role: "system",
        content: [{ type: "input_text", text: this.summaryBacklog.join(" ") }],
      } as unknown as ResponseItem);
    }
    result.push(...keep);

    while (this.count(result) > this.maxTokens && result.length > 1) {
      const removed = result.splice(1, 1)[0] as ResponseItem;
      // eslint-disable-next-line no-await-in-loop -- summarization is sequential
      await this.summarizeOld([removed]);
      if (result[0]) {
        (result[0] as { content: Array<TextPart> }).content = [
          { type: "input_text", text: this.summaryBacklog.join(" ") },
        ];
      }
    }
    return result;
  }
}

