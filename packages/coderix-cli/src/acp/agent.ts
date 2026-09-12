/**
 * ACP Agent — Coderix QueryEngine → ACP protocol adapter.
 *
 * Registers handlers on an AgentApp for session lifecycle and prompt processing.
 */

import type { AgentApp } from '@agentclientprotocol/sdk';
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  InitializeResponse,
  AgentCapabilities,
  NewSessionRequest,
  NewSessionResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  PromptRequest,
  PromptResponse,
  SetSessionModeRequest,
  CancelNotification,
  SessionNotification,
  ToolCallUpdate,
  RequestPermissionRequest,
  PermissionOption,
} from '@agentclientprotocol/sdk';

import { loadConfig, loadSettings, getMaxToolConcurrency } from '@coderix/core';
import { createCallModel } from '@coderix/core';
import { QueryEngine } from '@coderix/core';
import { SessionManager } from '@coderix/core';
import { SystemPromptAssembler } from '@coderix/core';
import { SubAgentRegistry } from '@coderix/core';
import { PermissionMode, type DeferredPermission, type AgentError } from '@coderix/core';
import { plugins } from '@coderix/core';
import { ToolRegistry } from '@coderix/core';
import { setSubAgentRegistry } from '@coderix/core';
import { buildAgentRegistry } from '@coderix/core';
import { isSlashCommand, parseSlashCommand } from '../commands/handler.js';
import { findSlashCommand } from '../commands/registry.js';
import type { AppConfig } from '../types.js';

// ---------------------------------------------------------------------------
// Tool registry builder (mirrors gateway/server.ts)
// ---------------------------------------------------------------------------

function buildAcpToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const plugin of plugins) {
    if (!plugin.isEnabled || plugin.isEnabled()) {
      registry.register(
        {
          name: plugin.name,
          description: plugin.schema.description ?? '',
          input_schema: plugin.schema.input_schema ?? { type: 'object', properties: {} },
        },
        async (input, ctx) => {
          const result = await plugin.executor(input, {
            cwd: ctx.cwd ?? process.cwd(),
            allowMutation: true,
            maxOutput: 50_000,
            signal: ctx.signal,
            agentSpawn: (ctx as any).agentSpawn,
            setPermissionMode: (ctx as any).setPermissionMode,
            getPermissionMode: (ctx as any).getPermissionMode,
            planModeState: (ctx as any).planModeState,
            sessionId: (ctx as any).sessionId,
            toolUseId: (ctx as any).toolUseId,
          } as any);
          return result as any;
        },
      );
    }
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------

interface ActiveSession {
  engine: QueryEngine;
  sessionManager: SessionManager;
}

const sessions = new Map<string, ActiveSession>();

async function createEngine(cwd: string): Promise<{ engine: QueryEngine; sessionId: string; model: string }> {
  const config = loadConfig();
  const callModel = createCallModel(config, config.model);
  const toolRegistry = buildAcpToolRegistry();
  const sessionManager = new SessionManager();
  sessionManager.create({ cwd, model: config.model });
  const settings = loadSettings();
  const subAgentRegistry = new SubAgentRegistry();
  setSubAgentRegistry(subAgentRegistry);
  const systemPromptAssembler = new SystemPromptAssembler();
  const { registry: agentRegistry } = await buildAgentRegistry(cwd);

  const engine = new QueryEngine({
    cwd,
    toolRegistry,
    sessionManager,
    callModel,
    model: config.model,
    maxToolConcurrency: getMaxToolConcurrency(settings),
    subAgentRegistry,
    systemPromptAssembler,
    agentRegistry,
  });

  await engine.init();
  const session = sessionManager.getActive();
  sessions.set(session.id, { engine, sessionManager });
  return { engine, sessionId: session.id, model: config.model };
}

// ---------------------------------------------------------------------------
// Strip box-drawing chars
// ---------------------------------------------------------------------------

const RE_BOX = /[─-▟]+/g;

// ---------------------------------------------------------------------------
// Register handlers
// ---------------------------------------------------------------------------

export function createAcpAgent(app: AgentApp, _appConfig: AppConfig): void {
  // ── initialize ──
  app.onRequest('initialize', async ({ params }) => {
    const caps: AgentCapabilities = {
      loadSession: true,
      promptCapabilities: { image: false, embeddedContext: false },
      sessionCapabilities: { list: {}, delete: {}, resume: {}, close: {} },
    };
    const resp: InitializeResponse = {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      agentCapabilities: caps,
      agentInfo: { name: 'coderix', version: '0.1.0' },
    };
    return resp;
  });

  // ── session/new ──
  app.onRequest('session/new', async ({ params: req }) => {
    const cwd = (req as any).cwd ?? process.cwd();
    const { sessionId, model } = await createEngine(cwd);
    const resp: NewSessionResponse = {
      sessionId,
      _meta: { model },
      modes: {
        currentModeId: 'ask',
        availableModes: [
          { id: 'ask', name: 'Ask', description: 'Ask before each tool' },
          { id: 'auto', name: 'Auto', description: 'Auto-approve all tools' },
          { id: 'plan', name: 'Plan', description: 'Plan mode — only safe tools' },
        ],
      },
    };
    return resp;
  });

  // ── session/list ──
  app.onRequest('session/list', async () => {
    const mgr = new SessionManager();
    const list = mgr.list();
    const resp: ListSessionsResponse = {
      sessions: list.map((s) => ({
        sessionId: s.id,
        cwd: process.cwd(),
        title: s.title,
        updatedAt: s.updatedAt.toISOString(),
        _meta: { turnCount: s.turnCount },
      })),
    };
    return resp;
  });

  // ── session/load ──
  app.onRequest('session/load', async ({ params: req, client }) => {
    const cwd = req.cwd ?? process.cwd();
    const mgr = new SessionManager();
    const session = mgr.resume(req.sessionId);

    const engine = await createEngine(cwd);
    // Stream session history back as agent_message_chunk updates
    for (const msg of session.messages) {
      const role = msg.role === 'assistant' ? 'Assistant' : msg.role === 'user' ? 'User' : 'System';
      const text = typeof msg.content === 'string' ? msg.content.slice(0, 500) : '(non-text content)';
      await client.notify('session/update', {
        sessionId: engine.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk' as const,
          content: { type: 'text', text: `[${role}]: ${text}\n` },
        },
      } as any);
    }
    return { modes: undefined } satisfies LoadSessionResponse;
  });

  // ── session/delete ──
  app.onRequest('session/delete', async ({ params: req }) => {
    sessions.delete(req.sessionId);
    const mgr = new SessionManager();
    mgr.delete(req.sessionId);
    return {};
  });

  // ── session/resume ──
  app.onRequest('session/resume', async ({ params: req }) => {
    const cwd = req.cwd ?? process.cwd();
    const mgr = new SessionManager();
    const session = mgr.resume(req.sessionId);
    await createEngine(cwd);
    const messages = session.messages.map((m) => {
      let text: string;
      if (typeof m.content === 'string') {
        text = m.content.slice(0, 500);
      } else if (Array.isArray(m.content)) {
        text = m.content
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text ?? '')
          .join(' ')
          .slice(0, 500);
      } else {
        text = '(non-text content)';
      }
      return { role: m.role, text };
    });
    const resp: ResumeSessionResponse = {
      modes: undefined,
      _meta: { title: session.title, messages },
    };
    return resp;
  });

  // ── session/close ──
  app.onRequest('session/close', async ({ params: req }) => {
    const s = sessions.get(req.sessionId);
    if (s) {
      s.engine.interrupt();
      sessions.delete(req.sessionId);
    }
    return {};
  });

  // ── session/set_mode ──
  app.onRequest('session/set_mode', async ({ params: req }) => {
    const s = sessions.get(req.sessionId);
    if (!s) throw new Error(`Session not found: ${req.sessionId}`);
    const modeMap: Record<string, PermissionMode> = {
      ask: PermissionMode.ASK,
      auto: PermissionMode.AUTO,
      plan: PermissionMode.PLAN,
    };
    const mode = modeMap[req.modeId] ?? PermissionMode.ASK;
    s.engine.setPermissionMode(mode);
    return {};
  });

  // ── session/prompt ──
  app.onRequest('session/prompt', async ({ params: req, client }) => {
    const s = sessions.get(req.sessionId);
    if (!s) throw new Error(`Session not found: ${req.sessionId}`);

    // Extract text from prompt blocks
    const texts: string[] = [];
    for (const block of req.prompt) {
      if (block.type === 'text') {
        texts.push((block as { type: 'text'; text: string }).text);
      }
    }
    let input = texts.join('\n');

    // Auto-title session from first message, and persist
    const sess = s.sessionManager.getActive();
    if (sess && sess.turnCount <= 1 && input.length > 0) {
      sess.title = input.length > 50 ? input.slice(0, 50).replace(/[\r\n]+/g, ' ') + '...' : input.replace(/[\r\n]+/g, ' ');
      s.sessionManager.saveSession(sess);
    }

    // Slash command interception
    if (isSlashCommand(input)) {
      const parsed = parseSlashCommand(input);
      const cmd = findSlashCommand(parsed.name);
      if (cmd) {
        let sysText: string | null = null;
        let sendText: string | null = null;

        cmd.run(parsed.arg, {
          rawCommand: input,
          arg: parsed.arg,
          dispatch: (() => {}) as any,
          send: (text: string) => { sendText = text; },
          compact: () => {},
          sys: (msg: string) => { sysText = msg; },
          exit: () => {},
          model: 'unknown',
          isStreaming: false,
          inputText: input,
        });

        if (sendText) input = sendText;
        if (sysText) {
          await client.notify('session/update', {
            sessionId: req.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk' as const,
              content: { type: 'text', text: sysText },
            },
          } satisfies SessionNotification);
          return { stopReason: 'end_turn' as const } satisfies PromptResponse;
        }
      }
    }

    // Submit to engine
    const gen = s.engine.submitMessage(input);

    try {
      let result = await gen.next();
      while (!result.done) {
        const event = result.value;
        const sid = req.sessionId;

        if (event.type === 'message') {
          // event.data is QueryMessage; contains either stream_event or assistant
          const msg = (event as any).data;
          const msgType = msg?.type;

          if (msgType === 'stream_event') {
            const msgEvent = msg.event;
            if (msgEvent?.type === 'content_block_delta') {
              const delta = msgEvent.delta;
              if (delta?.type === 'text_delta' && delta.text) {
                const clean = (delta.text as string).replace(RE_BOX, '');
                if (clean) {
                  await client.notify('session/update', {
                    sessionId: sid,
                    update: {
                      sessionUpdate: 'agent_message_chunk' as const,
                      content: { type: 'text', text: clean },
                    },
                  } satisfies SessionNotification);
                }
              } else if (delta?.type === 'thinking_delta' && delta.thinking) {
                await client.notify('session/update', {
                  sessionId: sid,
                  update: {
                    sessionUpdate: 'agent_thought_chunk' as const,
                    content: { type: 'text', text: delta.thinking },
                  },
                } satisfies SessionNotification);
              }
            }
            // Tool call start / thinking block start
            if (msgEvent?.type === 'content_block_start') {
              const cb = msgEvent.content_block;
              if (cb?.type === 'tool_use' && cb.id && cb.name) {
                const tool: ToolCallUpdate = {
                  toolCallId: cb.id,
                  title: cb.name ?? 'tool',
                  status: 'in_progress',
                  rawInput: cb.input ? JSON.stringify(cb.input) : '{}',
                };
                await client.notify('session/update', {
                  sessionId: sid,
                  update: { sessionUpdate: 'tool_call' as const, ...tool, title: (tool.title ?? 'tool') },
                } as any);
              } else if (cb?.type === 'thinking' && cb.thinking) {
                await client.notify('session/update', {
                  sessionId: sid,
                  update: {
                    sessionUpdate: 'agent_thought_chunk' as const,
                    content: { type: 'text', text: cb.thinking },
                  },
                } satisfies SessionNotification);
              }
            }
            // Tool use block stop → tool_call_update
            if (msgEvent?.type === 'content_block_stop') {
              // Track completed blocks for tool_call_update
            }
          } else if (msgType === 'assistant') {
            // Non-streaming fallback: send full response text
            const am = msg.message;
            const text = typeof am?.content === 'string'
              ? (am.content as string).replace(RE_BOX, '')
              : Array.isArray(am?.content)
                ? am.content.filter((b: any) => b.type === 'text').map((b: any) => b.text ?? '').join('')
                : '';
            if (text) {
              await client.notify('session/update', {
                sessionId: sid,
                update: {
                  sessionUpdate: 'agent_message_chunk' as const,
                  content: { type: 'text', text },
                },
              } satisfies SessionNotification);
            }
          } else if (msgType === 'user') {
            // Tool results → tool_call_update
            const um = msg.message;
            if (Array.isArray(um?.content)) {
              for (const block of um.content) {
                if (block.type === 'tool_result' && block.tool_use_id) {
                  const resultText = typeof block.content === 'string'
                    ? block.content
                    : (block.content ? JSON.stringify(block.content).slice(0, 2000) : '');
                  await client.notify('session/update', {
                    sessionId: sid,
                    update: {
                      sessionUpdate: 'tool_call_update' as const,
                      toolCallId: block.tool_use_id,
                      status: block.is_error ? 'failed' : 'completed',
                      rawOutput: resultText,
                    },
                  } as any);
                }
              }
            }
          } else if (msgType === 'system' && msg.subtype === 'progress') {
            const prog = msg.data as any;
            const progressText = prog?.message ?? `Running ${prog?.toolName ?? 'task'}...`;
            await client.notify('session/update', {
              sessionId: sid,
              update: {
                sessionUpdate: 'agent_message_chunk' as const,
                content: { type: 'text', text: `[Progress] ${progressText}` },
              },
            } satisfies SessionNotification);
          }
        } else if (event.type === 'cost') {
          const costData = (event as any).data;
          await client.notify('session/update', {
            sessionId: sid,
            update: {
              sessionUpdate: 'usage_update' as const,
              used: (costData?.inputTokens ?? 0) + (costData?.outputTokens ?? 0),
              cost: costData?.totalCost,
            },
          } as any);
        } else if (event.type === 'compact') {
          const compactData = (event as any).data;
          await client.notify('session/update', {
            sessionId: sid,
            update: {
              sessionUpdate: 'usage_update' as const,
              used: compactData?.metadata?.afterTokens,
              size: compactData?.metadata?.contextWindow,
            },
          } as any);
        } else if (event.type === 'permission_required') {
          const deferred = event.deferred as DeferredPermission | undefined;
          if (deferred) {
            const options: PermissionOption[] = [
              { optionId: 'allow_once', name: 'Allow once', kind: 'allow_once' },
              { optionId: 'allow_always', name: 'Allow always', kind: 'allow_always' },
              { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' },
            ];
            const permReq: RequestPermissionRequest = {
              sessionId: sid,
              toolCall: {
                toolCallId: deferred.toolUseId,
                title: deferred.toolName,
                status: 'in_progress',
                rawInput: deferred.command ?? '{}',
              },
              options,
            };
            const permResp = await client.request('session/request_permission', permReq);
            const outcome = permResp.outcome;
            const allowed =
              outcome.outcome === 'selected'
                ? outcome.optionId === 'allow_once' || outcome.optionId === 'allow_always'
                : false;
            deferred.resolve(allowed);
          }
        } else if (event.type === 'error') {
          const err = (event as any).data as AgentError | undefined;
          await client.notify('session/update', {
            sessionId: sid,
            update: {
              sessionUpdate: 'agent_message_chunk' as const,
              content: { type: 'text', text: `\n\nError: ${err?.message ?? 'unknown error'}` },
            },
          } satisfies SessionNotification);
        } else if (event.type === 'done') {
          // turn complete
        }

        result = await gen.next();
      }
    } catch (err) {
      await client.notify('session/update', {
        sessionId: req.sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk' as const,
          content: { type: 'text', text: `\n\nFatal error: ${(err as Error).message}` },
        },
      } satisfies SessionNotification);
    }

    return { stopReason: 'end_turn' as const } satisfies PromptResponse;
  });

  // ── session/cancel ──
  app.onNotification('session/cancel', async ({ params: req }) => {
    const s = sessions.get(req.sessionId);
    if (s) s.engine.interrupt();
  });
}
