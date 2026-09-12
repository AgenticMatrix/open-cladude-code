/**
 * openai-adapter.ts — Bridge from OpenAI-compatible Chat Completions APIs to
 * the core callModel AsyncGenerator.
 *
 * Mirrors provider-adapter.ts's `createCallModelFromClient`, but speaks the
 * OpenAI Chat Completions wire protocol (native fetch + SSE) instead of the
 * Anthropic Messages SDK. Emits the SAME core StreamEvent / AssistantMessage
 * shapes that query.ts's agent loop consumes, so OpenAI-compatible endpoints
 * (openai, grok, qwen, google, bytedance, openrouter, local) work unchanged.
 */

import { fetch as undiciFetch, ProxyAgent } from 'undici';

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

// ---------------------------------------------------------------------------
// Shared call-model configuration (also consumed by provider-adapter.ts)
// ---------------------------------------------------------------------------

export interface CallModelConfig {
  baseUrl: string;
  apiKey: string;
  /** Wire protocol override. Defaults to URL detection. */
  protocol?: 'anthropic' | 'openai';
  /** HTTP/HTTPS proxy URL (e.g. "http://127.0.0.1:7890"). */
  proxy?: string;
  /** Maximum output tokens. Defaults to 32768. */
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// OpenAI API types (minimal)
// ---------------------------------------------------------------------------

interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

interface OpenAISSEChunk {
  choices?: Array<{
    index: number;
    delta?: {
      content?: string;
      reasoning_content?: string;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

// ---------------------------------------------------------------------------
// Message / tool conversion (core → OpenAI)
// ---------------------------------------------------------------------------

function toOpenAIMessages(
  system: string,
  messages: Array<{ role: string; content: string | ContentBlock[] }>,
): OpenAIMessage[] {
  const normalized = normalizeMessagesForAPI(messages);
  const result: OpenAIMessage[] = [];

  if (system) {
    result.push({ role: 'system', content: system });
  }

  for (const msg of normalized) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role as 'user' | 'assistant', content: msg.content });
      continue;
    }

    const textBlocks: string[] = [];
    const toolCalls: NonNullable<OpenAIMessage['tool_calls']> = [];
    const toolResults: Array<{ tool_call_id: string; content: string }> = [];

    for (const block of msg.content) {
      switch (block.type) {
        case 'text':
          if (block.text) textBlocks.push(block.text);
          break;
        case 'tool_use':
          if (block.id && block.name) {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input ?? {}),
              },
            });
          }
          break;
        case 'tool_result':
          if (block.tool_use_id) {
            const resultContent = typeof block.content === 'string'
              ? block.content
              : Array.isArray(block.content)
                ? block.content.map((b) => ('text' in b ? b.text : '')).join('\n')
                : '';
            toolResults.push({ tool_call_id: block.tool_use_id, content: resultContent });
          }
          break;
        case 'thinking':
        case 'image':
          // OpenAI Chat Completions does not accept thinking/image blocks in
          // the message history — reasoning is display-only.
          break;
      }
    }

    if (toolCalls.length > 0) {
      result.push({
        role: 'assistant',
        content: textBlocks.length > 0 ? textBlocks.join('\n') : null,
        tool_calls: toolCalls,
      });
    }

    // Tool results become `role: 'tool'` messages (they follow the assistant
    // tool_calls message in the history), regardless of tool_calls presence.
    for (const tr of toolResults) {
      result.push({ role: 'tool', tool_call_id: tr.tool_call_id, content: tr.content });
    }

    if (toolCalls.length === 0 && toolResults.length === 0) {
      if (msg.role === 'assistant' && textBlocks.length > 0) {
        result.push({ role: 'assistant', content: textBlocks.join('\n') });
      } else if (msg.role === 'user') {
        result.push({ role: 'user', content: textBlocks.join('\n') || '' });
      }
    }
  }

  return result;
}

function toOpenAITools(tools: unknown[]): Array<{
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}> {
  return tools.map((t) => {
    const def = t as Record<string, unknown>;
    const schema = (def.input_schema ?? {}) as Record<string, unknown>;
    return {
      type: 'function' as const,
      function: {
        name: def.name as string,
        description: def.description as string,
        parameters: {
          type: 'object',
          properties: (schema.properties as Record<string, unknown>) ?? {},
          required: (schema.required as string[]) ?? [],
          additionalProperties: false,
        },
      },
    };
  });
}

function mapStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'length':
      return 'max_tokens';
    case 'stop':
    default:
      return 'end_turn';
  }
}

// ---------------------------------------------------------------------------
// Streaming adapter
// ---------------------------------------------------------------------------

/**
 * Create a callModel function for an OpenAI-compatible endpoint.
 * Signature matches createCallModelFromClient (see query.ts's CallModelParams).
 */
export function createCallModelFromOpenAI(
  config: CallModelConfig,
  model: string,
): (params: CallModelParams) => AsyncGenerator<StreamEvent | AssistantMessage> {
  const proxyAgent = config.proxy ? new ProxyAgent({ uri: config.proxy }) : undefined;

  return async function* (params: CallModelParams): AsyncGenerator<StreamEvent | AssistantMessage> {
    const { system, messages, tools, signal } = params;

    const baseUrl = config.baseUrl.trim().replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;
    const openaiMessages = toOpenAIMessages(system, messages);
    const openaiTools = tools.length > 0 ? toOpenAITools(tools) : [];

    const requestBody: Record<string, unknown> = {
      model,
      messages: openaiMessages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: config.maxTokens ?? 32768,
    };
    if (openaiTools.length > 0) {
      requestBody.tools = openaiTools;
      requestBody.tool_choice = 'auto';
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });

    // Streaming state
    let streamedText = '';
    let streamedReasoning = '';
    const toolCallBuilders = new Map<number, { id: string; name: string; arguments: string }>();
    let finishReason: string | null = null;
    let inputTokens = 0;
    let outputTokens = 0;

    // Core content-block index tracking. query.ts streams tool blocks one at a
    // time (single buildingBlock), so tool blocks are emitted sequentially at
    // the end — never interleaved by OpenAI's parallel tool_call index.
    let nextIndex = 0;
    let textIndex = -1;
    let thinkingIndex = -1;
    let textStarted = false;
    let thinkingStarted = false;

    /** Process one parsed SSE chunk, emitting core events in-order. */
    function* processChunk(chunk: OpenAISSEChunk): Generator<StreamEvent> {
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;

      if (delta) {
        // Reasoning content (DeepSeek reasoner / Gemini thinking) → thinking block
        if (delta.reasoning_content) {
          if (!thinkingStarted) {
            thinkingIndex = nextIndex++;
            thinkingStarted = true;
            yield { type: 'content_block_start', index: thinkingIndex, content_block: { type: 'thinking', thinking: '' } };
          }
          streamedReasoning += delta.reasoning_content;
          yield { type: 'content_block_delta', index: thinkingIndex, delta: { type: 'thinking_delta', thinking: delta.reasoning_content } };
        }

        // Text content
        if (delta.content) {
          if (thinkingStarted) {
            yield { type: 'content_block_stop', index: thinkingIndex };
            thinkingStarted = false;
          }
          if (!textStarted) {
            textIndex = nextIndex++;
            textStarted = true;
            yield { type: 'content_block_start', index: textIndex, content_block: { type: 'text', text: '' } };
          }
          streamedText += delta.content;
          yield { type: 'content_block_delta', index: textIndex, delta: { type: 'text_delta', text: delta.content } };
        }

        // Tool calls (accumulate; emitted in-order at finish)
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (tc.id) {
              toolCallBuilders.set(idx, {
                id: tc.id,
                name: tc.function?.name ?? '',
                arguments: tc.function?.arguments ?? '',
              });
            } else if (tc.function) {
              const existing = toolCallBuilders.get(idx);
              if (existing) {
                if (tc.function.name) existing.name = tc.function.name;
                if (tc.function.arguments) existing.arguments += tc.function.arguments;
              }
            }
          }
        }
      }

      if (choice?.finish_reason) finishReason = choice.finish_reason;
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
      }
    }

    try {
      const fetchInit: Record<string, unknown> = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      };
      if (proxyAgent) fetchInit.dispatcher = proxyAgent;

      const response = await undiciFetch(url, fetchInit as never);

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        const error = new Error(`OpenAI HTTP ${response.status}: ${errorBody.slice(0, 500)}`) as Error & { status?: number };
        error.status = response.status;
        throw error;
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      yield { type: 'message_start', message: { model, usage: { input_tokens: 0, output_tokens: 0 } } };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const dataStr = trimmed.slice(6);
          if (dataStr === '[DONE]') continue;
          let chunk: OpenAISSEChunk;
          try {
            chunk = JSON.parse(dataStr);
          } catch {
            continue;
          }
          yield* processChunk(chunk);
        }
      }

      // Flush any remaining buffered line
      const remaining = buffer.trim();
      if (remaining.startsWith('data: ') && remaining.slice(6) !== '[DONE]') {
        try {
          const chunk: OpenAISSEChunk = JSON.parse(remaining.slice(6));
          yield* processChunk(chunk);
        } catch { /* skip malformed tail */ }
      }
    } catch (err) {
      if (signal?.aborted) return;
      throw err;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }

    // Close open text/thinking blocks before tool blocks
    if (thinkingStarted) {
      yield { type: 'content_block_stop', index: thinkingIndex };
      thinkingStarted = false;
    }
    if (textStarted) {
      yield { type: 'content_block_stop', index: textIndex };
      textStarted = false;
    }

    // Emit buffered tool calls sequentially (start → full-args delta → stop)
    const toolUses: ToolUseBlock[] = [];
    for (const [, tc] of [...toolCallBuilders.entries()].sort((a, b) => a[0] - b[0])) {
      const idx = nextIndex++;
      let parsedInput: Record<string, unknown> = {};
      try {
        parsedInput = JSON.parse(tc.arguments || '{}');
      } catch {
        parsedInput = {};
      }
      toolUses.push({ type: 'tool_use', id: tc.id, name: tc.name, input: parsedInput });
      yield { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: tc.id, name: tc.name, input: {} } };
      yield { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: tc.arguments || '{}' } };
      yield { type: 'content_block_stop', index: idx };
    }

    const stopReason = mapStopReason(finishReason);
    const usage: CompletionUsage = { input_tokens: inputTokens, output_tokens: outputTokens };

    yield { type: 'message_delta', delta: { stop_reason: stopReason, usage } };

    const content: ContentBlock[] = [];
    if (streamedReasoning) content.push({ type: 'thinking', thinking: streamedReasoning });
    if (streamedText) content.push({ type: 'text', text: streamedText });
    for (const tu of toolUses) content.push(tu);

    const assistantMsg: AssistantMessage = {
      role: 'assistant',
      content,
      stopReason,
      usage,
      model,
      toolUseBlocks: toolUses,
    };

    yield { type: 'message_stop', message: assistantMsg };
  };
}
