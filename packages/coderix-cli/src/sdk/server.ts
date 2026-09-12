/**
 * server.ts — Coderix `--sdk` stream-json gateway.
 *
 * A headless, subprocess-friendly protocol for SDK clients (Python, or any
 * language). Reads newline-delimited JSON on stdin, writes SDK messages as
 * newline-delimited JSON on stdout.
 *
 * Input lines:
 *   { "type": "user", "message": { "role": "user", "content": "..." } }
 *   { "type": "control_request", "request": { "subtype": "set_permission_mode", "mode": "..." } }
 *   { "type": "control_request", "request": { "subtype": "interrupt" } }
 *
 * Output: one SDKMessage per line. A single `init` message leads the stream;
 * each user turn is followed by a terminal `result` message (so both one-shot
 * `query()` and a long-lived client can demultiplex per-query results). The
 * schema is shared with the in-process TypeScript SDK via @coderix/core's
 * mapper (single source of truth).
 */

import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import {
  loadConfig,
  loadSettings,
  getMaxToolConcurrency,
  createCallModel,
  SessionManager,
  ToolRegistry,
  QueryEngine,
  SubAgentRegistry,
  SystemPromptAssembler,
  buildAgentRegistry,
  setSubAgentRegistry,
  plugins,
  RiskLevel,
  PermissionMode,
  mapEngineEventToSdkMessage,
  buildInitMessage,
  buildResultMessage,
  fromCorePermissionMode,
  toCorePermissionMode,
} from '@coderix/core';
import type {
  SDKMessage,
  DeferredPermission,
  DeferredQuestion,
  CompletionUsage,
} from '@coderix/core';

// ── Tool registry (mirrors gateway/server.ts) ────────────────────────

function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const plugin of plugins) {
    if (plugin.isEnabled && !plugin.isEnabled()) continue;
    const schema = plugin.schema as unknown as Record<string, unknown>;
    const inputSchema = schema.input_schema as Record<string, unknown>;
    const meta = schema._meta as { riskLevel?: string; isConcurrencySafe?: boolean } | undefined;
    const riskLevel =
      meta?.riskLevel === 'safe' ? RiskLevel.SAFE :
      meta?.riskLevel === 'destructive' ? RiskLevel.DESTRUCTIVE :
      RiskLevel.MUTATION;
    registry.register(
      {
        name: plugin.name,
        description: (schema.description as string) ?? plugin.name,
        input_schema: inputSchema,
        riskLevel,
        isConcurrencySafe: meta?.isConcurrencySafe ?? false,
      },
      async (input, ctx) => {
        try {
          const r = await plugin.executor(input, {
            cwd: ctx.cwd ?? process.cwd(),
            allowMutation: true,
            maxOutput: 50_000,
            bashTimeout: ctx.timeoutMs ?? 30_000,
            agentSpawn: ctx.agentSpawn,
            sessionId: ctx.sessionId,
            setPermissionMode: ctx.setPermissionMode,
            getPermissionMode: ctx.getPermissionMode,
            planModeState: ctx.planModeState,
            readFileTracker: ctx.readFileTracker,
            toolUseId: ctx.toolUseId,
          });
          return { content: r.content, isError: r.isError, duration: r.duration, metadata: r.metadata };
        } catch (err) {
          return { content: `Tool error: ${(err as Error).message}`, isError: true };
        }
      },
    );
  }
  return registry;
}

// ── Server ───────────────────────────────────────────────────────────

export async function startSdkServer(): Promise<void> {
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(`Config error: ${(err as Error).message}\n`);
    process.exit(1);
  }

  const callModel = createCallModel(config, config.model);
  const toolRegistry = buildToolRegistry();
  const sessionManager = new SessionManager();
  sessionManager.create({ cwd: process.cwd(), model: config.model });
  const sessionId = sessionManager.getActive()?.id ?? '';

  const settings = loadSettings();
  const subAgentRegistry = new SubAgentRegistry();
  setSubAgentRegistry(subAgentRegistry);
  const systemPromptAssembler = new SystemPromptAssembler();
  const { registry: agentRegistry } = await buildAgentRegistry(process.cwd());

  const engine = new QueryEngine({
    cwd: process.cwd(),
    toolRegistry,
    sessionManager,
    callModel,
    model: config.model,
    maxToolConcurrency: getMaxToolConcurrency(settings),
    subAgentRegistry,
    systemPromptAssembler,
    agentRegistry,
    settings,
  });

  await engine.init();
  engine.setPermissionMode((settings.default_permission_mode as PermissionMode) ?? PermissionMode.ASK);

  const uuid = () => randomUUID();
  const emit = (msg: SDKMessage) => process.stdout.write(JSON.stringify(msg) + '\n');

  emit(buildInitMessage({
    sessionId,
    cwd: process.cwd(),
    tools: toolRegistry.names,
    mcpServers: [],
    model: config.model,
    permissionMode: fromCorePermissionMode(engine.getPermissionEngine().getMode()),
    uuid: uuid(),
  }));

  let lastError = false;

  const runTurn = async (text: string): Promise<void> => {
    let numTurns = 0;
    let totalCostUsd = 0;
    let usage: CompletionUsage = { input_tokens: 0, output_tokens: 0 };
    let resultText = '';
    let errorMessage: string | undefined;
    const turnStart = Date.now();

    try {
      for await (const ev of engine.submitMessage(text)) {
        switch (ev.type) {
          case 'permission_required':
            // Headless default: deny (no host canUseTool round-trip in v1).
            (ev.deferred as DeferredPermission).resolve(false);
            break;
          case 'question_required':
            (ev.deferred as DeferredQuestion).resolve({});
            break;
          case 'error':
            errorMessage =
              (ev.data as { message?: string } | undefined)?.message ?? 'Unknown error';
            break;
          case 'message': {
            const mapped = mapEngineEventToSdkMessage(ev, { sessionId, includePartialMessages: true, uuid });
            if (!mapped) break;

            if (mapped.type === 'assistant') {
              numTurns++;
              totalCostUsd += mapped.message.usage?.totalCost ?? 0;
              usage = mapped.message.usage;
              resultText = appendUnique(resultText, extractText(mapped.message.content));
            } else if (
              mapped.type === 'stream_event' &&
              mapped.event.type === 'content_block_delta' &&
              mapped.event.delta.type === 'text_delta'
            ) {
              resultText += mapped.event.delta.text;
            }

            emit(mapped);
            break;
          }
          case 'compact': {
            const mapped = mapEngineEventToSdkMessage(ev, { sessionId, includePartialMessages: true, uuid });
            if (mapped) emit(mapped);
            break;
          }
          default:
            break;
        }
        if (errorMessage) break;
      }
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : String(err);
    }

    lastError = !!errorMessage;
    emit(buildResultMessage({
      sessionId,
      uuid: uuid(),
      subtype: errorMessage ? 'error_during_execution' : 'success',
      isError: !!errorMessage,
      result: errorMessage ? `${resultText}${resultText ? '\n' : ''}${errorMessage}` : resultText,
      durationMs: Date.now() - turnStart,
      durationApiMs: 0,
      numTurns,
      totalCostUsd,
      usage,
    }));
  };

  // Concurrent stdin reader: control requests apply mid-turn; user messages queue.
  const rl = createInterface({ input: process.stdin });
  const queue: string[] = [];
  let processing = false;
  let closed = false;

  const flushExit = (code: number): void => {
    // Ensure buffered stdout is flushed to the pipe before exiting.
    process.stdout.write('', () => process.exit(code));
  };

  const maybeFinish = (): void => {
    if (closed && !processing && queue.length === 0) flushExit(lastError ? 1 : 0);
  };

  const drain = async (): Promise<void> => {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const text = queue.shift()!;
        await runTurn(text);
      }
    } finally {
      processing = false;
      maybeFinish();
    }
  };

  rl.on('line', (line: string) => {
    let req: { type?: string; message?: { role?: string; content?: unknown }; request?: { subtype?: string; mode?: string } };
    try {
      req = JSON.parse(line);
    } catch {
      return;
    }
    if (req.type === 'control_request') {
      const sub = req.request?.subtype;
      if (sub === 'set_permission_mode') {
        engine.setPermissionMode(toCorePermissionMode(req.request?.mode as never));
      } else if (sub === 'interrupt') {
        engine.interrupt();
      }
      return;
    }
    if (req.type === 'user') {
      const content = req.message?.content;
      const text = typeof content === 'string' ? content : '';
      if (text) {
        queue.push(text);
        void drain();
      }
    }
  });

  rl.on('close', () => {
    closed = true;
    maybeFinish();
  });
}

// ── Text helpers ──────────────────────────────────────────────────────

function extractText(content: string | Array<{ type: string; text?: string }>): string {
  if (typeof content === 'string') return content;
  return content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
}

function appendUnique(acc: string, text: string): string {
  if (!text) return acc;
  if (acc.endsWith(text)) return acc;
  if (text.endsWith(acc) && acc.length > 0) return text;
  return acc + text;
}
