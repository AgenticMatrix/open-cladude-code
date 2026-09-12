/**
 * provider-adapter.ts — Bridge from Anthropic SDK to callModel AsyncGenerator.
 *
 * Converts ink-chat-tui's core/types.ts Message format to the Anthropic
 * Messages API format, streams the response, and yields StreamEvent and
 * AssistantMessage objects compatible with query.ts's agent loop.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  StreamEvent,
  AssistantMessage,
  CompletionUsage,
  ToolUseBlock,
  ContentBlock,
  StopReason,
} from './types.js';
import type { CallModelParams } from './query.js';
import { normalizeMessagesForAPI } from './message-normalizer.js';
import { detectProtocol } from '../config.js';
import { createCallModelFromOpenAI, type CallModelConfig } from './openai-adapter.js';

export { createCallModelFromOpenAI } from './openai-adapter.js';
export type { CallModelConfig } from './openai-adapter.js';

// ---------------------------------------------------------------------------
// Message conversion: core/types.ts → Anthropic API format
// ---------------------------------------------------------------------------

interface AnthropicRequest {
  system: string;
  messages: Anthropic.MessageParam[];
}

/**
 * Convert our core Message[] (content: string | ContentBlock[]) to
 * Anthropic API format. System messages are extracted and returned
 * as the system parameter. User/assistant messages are converted
 * to Anthropic content block arrays or strings.
 */
function toAnthropicMessages(
  messages: Array<{ role: string; content: string | ContentBlock[] }>,
): AnthropicRequest {
  // Normalize messages before API conversion (merge, hoist, smoosh, pair repair)
  const normalized = normalizeMessagesForAPI(messages);

  const systemParts: string[] = [];
  const apiMessages: Anthropic.MessageParam[] = [];

  for (const m of normalized) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : '';
      if (text.trim()) systemParts.push(text);
      continue;
    }

    const role = m.role as 'user' | 'assistant';

    if (typeof m.content === 'string') {
      if (m.content.trim()) {
        apiMessages.push({ role, content: m.content });
      }
      continue;
    }

    // ContentBlock[] — convert to Anthropic content block array
    const content: Anthropic.ContentBlockParam[] = [];
    for (const block of m.content) {
      switch (block.type) {
        case 'text':
          if (block.text) {
            content.push({ type: 'text', text: block.text });
          }
          break;
        case 'tool_use':
          if (block.id && block.name) {
            content.push({
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: block.input ?? {},
            } as Anthropic.ToolUseBlockParam);
          }
          break;
        case 'tool_result':
          if (block.tool_use_id) {
            let resultContent: string | Anthropic.ContentBlockParam[];
            if (typeof block.content === 'string') {
              resultContent = block.content;
            } else if (Array.isArray(block.content)) {
              resultContent = block.content.map((sub: ContentBlock) => {
                if (sub.type === 'image' && sub.source) {
                  return {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: sub.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                      data: sub.source.data,
                    },
                  } as Anthropic.ImageBlockParam;
                }
                return { type: 'text', text: sub.text || '' } as Anthropic.TextBlockParam;
              });
            } else {
              resultContent = JSON.stringify(block.content);
            }
            content.push({
              type: 'tool_result',
              tool_use_id: block.tool_use_id,
              content: resultContent,
              is_error: block.is_error,
            } as Anthropic.ToolResultBlockParam);
          }
          break;
        case 'image':
          if (block.source) {
            content.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: block.source.media_type as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: block.source.data,
              },
            });
          }
          break;
        case 'thinking':
          // Thinking blocks must be passed back to the API on subsequent turns.
          // Anthropic — and DeepSeek's Anthropic-compatible endpoint — reject a
          // request (400 invalid_request_error) when a prior assistant turn's
          // thinking blocks are dropped in thinking mode: the `signature` is
          // required for the conversation to continue.
          if (block.thinking) {
            content.push({
              type: 'thinking',
              thinking: block.thinking,
              signature: block.signature ?? '',
            } as Anthropic.ThinkingBlockParam);
          }
          break;
      }
    }

    if (content.length > 0) {
      apiMessages.push({ role, content });
    }
  }

  return { system: systemParts.join('\n\n'), messages: apiMessages };
}

// ---------------------------------------------------------------------------
// Streaming adapter
// ---------------------------------------------------------------------------

/**
 * Convert Anthropic tool definitions from our generic format to
 * the format expected by the Anthropic SDK.
 */
function toAnthropicTools(tools: unknown[]): Anthropic.Tool[] {
  return tools.map((t) => {
    const def = t as Record<string, unknown>;
    return {
      name: def.name as string,
      description: def.description as string,
      input_schema: def.input_schema as Anthropic.Tool.InputSchema,
    };
  });
}

/**
 * Create a callModel function from an Anthropic client.
 *
 * The returned function has the signature expected by query.ts:
 *   AsyncGenerator<StreamEvent | AssistantMessage>
 *
 * It converts core types to Anthropic API format, streams the response,
 * and yields properly typed events back.
 */
export function createCallModelFromClient(
  client: Anthropic,
  model: string,
): (params: CallModelParams) => AsyncGenerator<StreamEvent | AssistantMessage> {
  return async function* (params: CallModelParams) {
    const { system, messages, tools, signal, cacheControl, thinking: thinkingConfig } = params;

    // Convert messages to Anthropic format
    const { system: extraSystem, messages: apiMessages } =
      toAnthropicMessages(messages);

    // Combine caller-provided system with extracted system messages
    const combinedSystem = [system, extraSystem]
      .filter(Boolean)
      .join('\n\n');

    // Build system parameter: use cache_control annotation when enabled (fork agents)
    const systemParam = cacheControl && combinedSystem
      ? [{ type: 'text' as const, text: combinedSystem, cache_control: { type: 'ephemeral' as const } }]
      : (combinedSystem || undefined);

    const anthropicTools = tools.length > 0 ? toAnthropicTools(tools) : undefined;

    // Track accumulated state during streaming
    const toolUses: ToolUseBlock[] = [];
    let streamedText = '';
    let streamedThinking = '';
    let thinkingSignature: string | undefined;
    let usage: CompletionUsage = { input_tokens: 0, output_tokens: 0 };
    let stopReason: StopReason | null = null;

    let lastContentBlockIndex = -1;

    try {
      const stream = await client.messages.create({
        model,
        max_tokens: 32768,
        system: systemParam,
        messages: apiMessages,
        ...(anthropicTools?.length ? { tools: anthropicTools } : {}),
        stream: true,
        thinking: thinkingConfig ?? { type: 'enabled', budget_tokens: 16000 },
      });

      for await (const event of stream) {
        if (signal?.aborted) break;

        switch (event.type) {
          case 'message_start':
            if (event.message) {
              usage = {
                input_tokens: event.message.usage?.input_tokens ?? 0,
                output_tokens: 0,
                cache_creation_input_tokens: event.message.usage?.cache_creation_input_tokens ?? 0,
                cache_read_input_tokens: event.message.usage?.cache_read_input_tokens ?? 0,
              };
            }
            yield {
              type: 'message_start',
              message: {
                model,
                usage: {
                  input_tokens: usage.input_tokens ?? 0,
                  output_tokens: 0,
                  cache_creation_input_tokens: usage.cache_creation_input_tokens,
                  cache_read_input_tokens: usage.cache_read_input_tokens,
                },
              },
            };
            break;

          case 'content_block_start': {
            const block = event.content_block;
            const index = event.index;
            lastContentBlockIndex = index;

            if (block.type === 'text') {
              yield {
                type: 'content_block_start',
                index,
                content_block: { type: 'text', text: '' },
              };
            } else if (block.type === 'tool_use') {
              // Spread pre-populated input when available (DeepSeek sends full
              // input in content_block_start). Standard Anthropic has empty {}.
              const initialInput = (block as { input?: object }).input as Record<string, unknown> | undefined;
              const hasInput = initialInput && Object.keys(initialInput).length > 0;
              const tu: ToolUseBlock = {
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: hasInput ? { ...initialInput } : {},
              };
              toolUses.push(tu);
              yield {
                type: 'content_block_start',
                index,
                content_block: { type: 'tool_use', id: block.id, name: block.name, input: hasInput ? { ...initialInput } : {} },
              };
            } else if (block.type === 'thinking') {
              // Capture the thinking block's initial content + signature so
              // the persisted assistant message keeps the reasoning trace.
              streamedThinking = (block as { thinking?: string }).thinking ?? '';
              thinkingSignature = (block as { signature?: string }).signature;
              yield {
                type: 'content_block_start',
                index,
                content_block: { type: 'thinking', thinking: '' },
              };
            }
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;
            const index = event.index;

            if (delta.type === 'text_delta') {
              streamedText += delta.text;
              yield {
                type: 'content_block_delta',
                index,
                delta: { type: 'text_delta', text: delta.text },
              };
            } else if (delta.type === 'input_json_delta') {
              // Accumulate JSON for the last tool_use block
              const last = toolUses[toolUses.length - 1];
              if (last) {
                const prev = (last.input as Record<string, unknown>)._partial as string ?? '';
                last.input = { ...last.input, _partial: prev + delta.partial_json };
              }
              yield {
                type: 'content_block_delta',
                index,
                delta: { type: 'input_json_delta', partial_json: delta.partial_json },
              };
            } else if (delta.type === 'thinking_delta') {
              streamedThinking += delta.thinking;
              yield {
                type: 'content_block_delta',
                index,
                delta: { type: 'thinking_delta', thinking: delta.thinking },
              };
            } else if (delta.type === 'signature_delta') {
              thinkingSignature = (delta as { signature?: string }).signature;
            }
            break;
          }

          case 'content_block_stop': {
            // Parse accumulated JSON for the most recent tool_use block
            // (blocks stream start→delta→stop sequentially, so the last toolUses
            // entry corresponds to the block that just finished streaming)
            const last = toolUses[toolUses.length - 1];
            if (last) {
              const partial = (last.input as Record<string, unknown>)._partial as string | undefined;
              if (partial) {
                try {
                  last.input = JSON.parse(partial);
                } catch {
                  last.input = { _raw: partial };
                }
              }
            }
            yield { type: 'content_block_stop', index: event.index };
            break;
          }

          case 'message_delta':
            stopReason = event.delta.stop_reason as StopReason | null ?? stopReason;
            if (event.usage) {
              usage = {
                ...usage,
                output_tokens: event.usage.output_tokens ?? usage.output_tokens,
              };
            }
            yield {
              type: 'message_delta',
              delta: { stop_reason: stopReason as StopReason, usage },
            };
            break;

          case 'message_stop': {
            const raw = event as unknown as Record<string, unknown>;
            const msgUsage = raw.message as Record<string, unknown> | undefined;
            const rawUsage = (msgUsage?.usage ?? {}) as Record<string, number>;
            const finalUsage: CompletionUsage = {
              input_tokens: rawUsage.input_tokens ?? usage.input_tokens,
              output_tokens: rawUsage.output_tokens ?? usage.output_tokens,
              cache_creation_input_tokens: rawUsage.cache_creation_input_tokens ?? usage.cache_creation_input_tokens,
              cache_read_input_tokens: rawUsage.cache_read_input_tokens ?? usage.cache_read_input_tokens,
            };

            // Build the content blocks for the assistant message
            const content: ContentBlock[] = [];
            if (streamedThinking) {
              content.push({
                type: 'thinking',
                thinking: streamedThinking,
                signature: thinkingSignature,
              });
            }
            if (streamedText) {
              content.push({ type: 'text', text: streamedText });
            }
            for (const tu of toolUses) {
              content.push(tu);
            }

            const assistantMsg: AssistantMessage = {
              role: 'assistant',
              content,
              stopReason: (stopReason || 'end_turn') as StopReason,
              usage: finalUsage,
              model,
              toolUseBlocks: toolUses,
            };

            yield {
              type: 'message_stop',
              message: assistantMsg,
            };
            break;
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) return;
      throw err;
    }
  };
}

// ---------------------------------------------------------------------------
// Protocol-dispatching factory
// ---------------------------------------------------------------------------

/**
 * Create a callModel function that routes by the endpoint's wire protocol.
 *
 * - `openai`  → OpenAI Chat Completions adapter (openai/grok/qwen/google/bytedance/openrouter/local).
 * - `anthropic` (default) → the existing Anthropic Messages SDK adapter.
 *
 * Protocol resolves as `config.protocol ?? detectProtocol(config.baseUrl)`, so
 * OpenAI-compatible endpoints are picked up automatically from their base URL.
 */
export function createCallModel(
  config: CallModelConfig,
  model: string,
): (params: CallModelParams) => AsyncGenerator<StreamEvent | AssistantMessage> {
  const protocol = config.protocol ?? detectProtocol(config.baseUrl);
  if (protocol === 'openai') {
    return createCallModelFromOpenAI(config, model);
  }

  const client = new Anthropic({
    baseURL: config.baseUrl,
    apiKey: config.apiKey,
  });
  return createCallModelFromClient(client, model);
}
