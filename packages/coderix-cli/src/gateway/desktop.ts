/**
 * desktop.ts — WebSocket Gateway Server for Desktop App
 *
 * Launched via `coderix --desktop [--desktop-port PORT]`.
 * Starts a WebSocket server that the Tauri webview frontend connects to.
 * Uses the same JSON-RPC protocol as server.ts, but over WebSocket
 * instead of stdin/stdout.
 *
 * Protocol: JSON-RPC 2.0 over WebSocket text frames.
 * Requests:  { id, method, params }
 * Responses: { id, result } or { id, error: { code, message } }
 * Events:    { type: 'event', event: { type, ... } }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { loadConfig, loadSettings, getMaxToolConcurrency } from '../cli/config.js';
import {
  createCallModel,
  ToolRegistry,
  SessionManager,
  QueryEngine,
  SubAgentRegistry,
  SystemPromptAssembler,
  plugins,
  PermissionMode,
  RiskLevel,
  buildAgentRegistry,
  setSubAgentRegistry,
} from '@coderix/core';
import type {
  DeferredPermission,
  AssistantMessage,
  QueryMessage,
} from '@coderix/core';
import { isSlashCommand, parseSlashCommand } from '../commands/handler.js';
import { findSlashCommand } from '../commands/registry.js';

// ── JSON-RPC ────────────────────────────────────────────────────────

interface RpcRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function makeResponse(
  id: number | string,
  result?: unknown,
  error?: { code: number; message: string },
): string {
  return JSON.stringify({ id, ...(error ? { error } : { result }) });
}

function makeEvent(ev: unknown): string {
  return JSON.stringify({ type: 'event', event: ev });
}

// ── Tool registry ───────────────────────────────────────────────────

function buildToolRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  for (const plugin of plugins) {
    const schema = plugin.schema as unknown as Record<string, unknown>;
    const inputSchema = schema.input_schema as Record<string, unknown>;
    const meta = schema._meta as
      | { riskLevel?: string; isConcurrencySafe?: boolean }
      | undefined;
    const riskLevel =
      meta?.riskLevel === 'safe'
        ? RiskLevel.SAFE
        : meta?.riskLevel === 'destructive'
          ? RiskLevel.DESTRUCTIVE
          : RiskLevel.MUTATION;
    registry.register(
      {
        name: plugin.name,
        description: (schema.description as string) ?? plugin.name,
        input_schema: inputSchema,
        riskLevel,
        isConcurrencySafe: meta?.isConcurrencySafe ?? false,
      },
      async (input: Record<string, unknown>, ctx: any) => {
        try {
          const r = await plugin.executor(input, {
            cwd: ctx.cwd ?? process.cwd(),
            allowMutation: true,
            maxOutput: 50_000,
            bashTimeout: ctx.timeoutMs ?? 30_000,
            agentSpawn: ctx.agentSpawn,
            sessionId: ctx.sessionId,
            setPermissionMode: ctx.setPermissionMode,
            toolUseId: ctx.toolUseId,
          });
          return {
            content: r.content,
            isError: r.isError,
            duration: r.duration,
            metadata: r.metadata,
          };
        } catch (err) {
          return {
            content: `Tool error: ${(err as Error).message}`,
            isError: true,
          };
        }
      },
    );
  }
  return registry;
}

// ── Event conversion ────────────────────────────────────────────────

let pendingDeferred: DeferredPermission | null = null;

const RE_BOX = /[─-▟]+/g;

function extractText(msg: AssistantMessage): string {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content))
    return msg.content
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text ?? '')
      .join('\n');
  return '';
}

function convertMessageEvent(msg: QueryMessage, sessionId: string): unknown[] {
  const events: unknown[] = [];
  const sid = sessionId;

  if (msg.type === 'stream_event' && msg.event) {
    const ev = msg.event;
    switch (ev.type) {
      case 'message_start':
        events.push({ type: 'message.start', session_id: sid });
        break;
      case 'content_block_delta': {
        const d = ev.delta!;
        if (d.type === 'text_delta')
          events.push({
            type: 'message.delta',
            payload: { text: (d.text as string).replace(RE_BOX, '') },
            session_id: sid,
          });
        else if (d.type === 'thinking_delta')
          events.push({
            type: 'message.delta',
            payload: { thinking: (d.thinking as string).replace(RE_BOX, '') },
            session_id: sid,
          });
        else if (d.type === 'input_json_delta')
          events.push({
            type: 'message.delta',
            payload: { json: (d.partial_json as string) },
            session_id: sid,
          });
        break;
      }
      case 'content_block_start': {
        const b = ev.content_block!;
        if (b.type === 'tool_use' && b.id && b.name) {
          events.push({
            type: 'tool.start',
            payload: {
              tool_id: b.id,
              name: b.name,
              args_text: b.input ? JSON.stringify(b.input) : undefined,
            },
            session_id: sid,
          });
        } else if (b.type === 'thinking' && b.thinking) {
          events.push({
            type: 'thinking.start',
            payload: {},
            session_id: sid,
          });
        }
        break;
      }
      case 'content_block_stop':
        events.push({ type: 'block.stop', session_id: sid });
        break;
      case 'message_delta':
      case 'message_stop':
        events.push({ type: 'message.stop', session_id: sid });
        break;
    }
  } else if (msg.type === 'assistant') {
    const am = msg.message as AssistantMessage;
    const text = extractText(am).replace(RE_BOX, '');
    events.push({
      type: 'message.complete',
      payload: {
        text,
        usage: {
          input: am.usage?.input_tokens ?? 0,
          output: am.usage?.output_tokens ?? 0,
          cache:
            (am.usage?.cache_creation_input_tokens ?? 0) +
            (am.usage?.cache_read_input_tokens ?? 0),
          total:
            (am.usage?.input_tokens ?? 0) +
            (am.usage?.output_tokens ?? 0) +
            (am.usage?.cache_creation_input_tokens ?? 0) +
            (am.usage?.cache_read_input_tokens ?? 0),
          cost_usd: am.usage?.totalCost,
        },
      },
      session_id: sid,
    });
  } else if (msg.type === 'system') {
    if (msg.subtype === 'progress') {
      const p = msg.data as any;
      if (p?.status === 'completed') {
        events.push({
          type: 'tool.complete',
          payload: {
            tool_id: p.toolUseId,
            name: p.toolName,
            duration_s: 0,
          },
          session_id: sid,
        });
      } else if (p?.status === 'running') {
        events.push({
          type: 'tool.progress',
          payload: {
            tool_id: p.toolUseId,
            name: p.toolName,
            status: 'running',
          },
          session_id: sid,
        });
      }
    } else if (msg.subtype === 'permission_required') {
      const d = msg.deferred as DeferredPermission | undefined;
      if (d) {
        pendingDeferred = d;
        events.push({
          type: 'approval.request',
          payload: {
            command: d.toolName,
            description: d.description || d.toolName,
            request_id: d.toolUseId,
            tool_use_id: d.toolUseId,
          },
          session_id: sid,
        });
      }
    }
  } else if (msg.type === 'user') {
    if (msg.message) {
      const m = msg.message as any;
      const blocks: unknown[] = [];
      if (typeof m.content === 'string') {
        blocks.push({ type: 'text', text: m.content });
      } else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (b.type === 'tool_result') {
            blocks.push({
              type: 'tool_result',
              tool_use_id: b.tool_use_id,
              content:
                typeof b.content === 'string'
                  ? b.content
                  : Array.isArray(b.content)
                    ? b.content.map((c: any) => c.text ?? '').join('')
                    : '',
              is_error: b.is_error ?? false,
              duration: b.duration,
              metadata: b.metadata,
            });
          } else {
            blocks.push(b);
          }
        }
      }
      events.push({
        type: 'tool_results',
        payload: { blocks },
        session_id: sid,
      });
    }
  }

  return events;
}

// ── Main server ─────────────────────────────────────────────────────

export interface DesktopGatewayOptions {
  port: number;
  cwd?: string;
}

export async function startDesktopGateway(
  options: DesktopGatewayOptions,
): Promise<void> {
  const { port, cwd = process.cwd() } = options;

  // ── Config & engine setup (shared with server.ts / main.tsx) ──
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig();
  } catch (err) {
    process.stderr.write(
      `Config error: ${(err as Error).message}\n`,
    );
    process.exit(1);
  }

  const callModel = createCallModel(config, config.model);
  const toolRegistry = buildToolRegistry();
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
  engine.setPermissionMode((settings.default_permission_mode as PermissionMode) ?? PermissionMode.ASK);

  let currentSessionId = sessionManager.list()[0]?.id ?? '';

  // ── WebSocket server (using the `ws` library) ──────────────────

  const wss = new WebSocketServer({ port, host: '127.0.0.1' });

  wss.on('connection', (ws: WebSocket) => {
    // Send ready event on connection
    ws.send(
      makeEvent({
        type: 'gateway.ready',
        payload: { model: config.model, session_id: currentSessionId },
      }),
    );

    ws.on('message', async (data: Buffer) => {
      let req: RpcRequest;
      try {
        req = JSON.parse(data.toString());
      } catch {
        return;
      }

      try {
        await handleRequest(req, ws);
      } catch (err) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            makeResponse(req.id, undefined, {
              code: -32603,
              message: (err as Error).message,
            }),
          );
        }
      }
    });

    ws.on('error', (_err: Error) => {
      // Ignore client errors
    });

    async function handleRequest(
      req: RpcRequest,
      ws: WebSocket,
    ): Promise<void> {
      switch (req.method) {
        // ── prompt.submit ──────────────────────────────────
        case 'prompt.submit': {
          let text = (req.params?.text as string) ?? '';

          // Slash command interception
          if (isSlashCommand(text)) {
            const parsed = parseSlashCommand(text);
            const cmd = findSlashCommand(parsed.name);
            if (cmd) {
              let sysMsg: string | null = null;
              let sendMsg: string | null = null;
              let handled = false;

              cmd.run(parsed.arg, {
                rawCommand: text,
                arg: parsed.arg,
                dispatch: () => {},
                send: (promptText: string) => {
                  sendMsg = promptText;
                },
                compact: () => {},
                sys: (msg: string) => {
                  sysMsg = msg;
                },
                exit: () => {},
                model: config.model,
                isStreaming: false,
                inputText: text,
                listSessions: () =>
                  sessionManager.list().map((s) => ({
                    id: s.id,
                    title: s.title,
                    turnCount: s.turnCount,
                    model: s.model,
                    updatedAt: s.updatedAt,
                    displayTitle: s.displayTitle,
                  })),
                resumeSession: (id: string) => {
                  if (id === '__last__') {
                    const list = sessionManager.list();
                    const target = list.find(
                      (s) => s.turnCount > 0 && s.id !== currentSessionId,
                    );
                    if (!target) {
                      sysMsg = 'No other sessions with content found.';
                      return;
                    }
                    id = target.id;
                  }
                  if (id === currentSessionId) {
                    sysMsg = 'Already viewing this session.';
                    return;
                  }
                  let session;
                  try {
                    session = sessionManager.resume(id);
                  } catch (e) {
                    sysMsg = `Failed to resume session: ${(e as Error).message}`;
                    return;
                  }
                  if (!session) return;
                  currentSessionId = id;
                  const msgs = session.messages
                    .map((m: any) => ({
                      role: m.role,
                      content: m.content,
                    }))
                    .filter((m: any) => {
                      if (typeof m.content === 'string') return m.content.length > 0;
                      if (Array.isArray(m.content)) return m.content.length > 0;
                      return false;
                    });
                  msgs.push({
                    role: 'system',
                    content: `Resumed session: ${session.title}`,
                  });
                  ws.send(
                    makeEvent({
                      type: 'session.history',
                      messages: msgs,
                      sessionId: id,
                    }),
                  );
                  ws.send(
                    makeEvent({
                      type: 'session.switched',
                      sessionId: id,
                      title: session.title,
                    }),
                  );
                  handled = true;
                },
              });

              if (handled) {
                ws.send(makeResponse(req.id, { ok: true }));
                return;
              }

              if (sysMsg !== null) {
                ws.send(
                  makeEvent({
                    type: 'message.complete',
                    payload: { text: '```\n' + sysMsg + '\n```' },
                    session_id: currentSessionId,
                  }),
                );
                ws.send(makeResponse(req.id, { ok: true }));
                return;
              }

              if (sendMsg !== null) {
                text = sendMsg;
              }
            }
          }

          // Auto-title from first message
          const s = sessionManager.get(currentSessionId);
          if (
            s &&
            (s.title.startsWith('Session ') || s.title === 'Untitled')
          ) {
            s.title = text.length > 50 ? text.slice(0, 50) + '...' : text;
            sessionManager.saveSession(s);
          }

          ws.send(
            makeEvent({
              type: 'message.start',
              session_id: currentSessionId,
            }),
          );

          for await (const ev of engine.submitMessage(text)) {
            switch (ev.type) {
              case 'message': {
                const events = convertMessageEvent(
                  ev.data as QueryMessage,
                  currentSessionId,
                );
                for (const e of events) {
                  if (ws.readyState !== WebSocket.OPEN) break;
                  ws.send(makeEvent(e));
                }
                break;
              }
              case 'error':
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    makeEvent({
                      type: 'status.update',
                      payload: {
                        text: `Error: ${(ev.data as any)?.message ?? ''}`,
                        kind: 'error',
                      },
                      session_id: currentSessionId,
                    }),
                  );
                }
                break;
              case 'permission_required': {
                const d = ev.deferred as DeferredPermission | undefined;
                if (d && ws.readyState === WebSocket.OPEN) {
                  pendingDeferred = d;
                  ws.send(
                    makeEvent({
                      type: 'approval.request',
                      payload: {
                        command: d.toolName,
                        description: d.description || d.toolName,
                        request_id: d.toolUseId,
                        tool_use_id: d.toolUseId,
                      },
                      session_id: currentSessionId,
                    }),
                  );
                }
                break;
              }
              case 'question_required': {
                const d = ev.deferred as any;
                if (d && ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    makeEvent({
                      type: 'question.request',
                      payload: {
                        tool_name: d.toolName,
                        tool_use_id: d.toolUseId,
                        questions: d.questions,
                      },
                      session_id: currentSessionId,
                    }),
                  );
                }
                break;
              }
              case 'done':
                break;
            }
          }

          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              makeEvent({
                type: 'status.update',
                payload: { text: 'Ready' },
                session_id: currentSessionId,
              }),
            );
            ws.send(makeResponse(req.id, { ok: true }));
          }
          break;
        }

        // ── approval.respond ──────────────────────────────
        case 'approval.respond': {
          const requestId = (req.params?.request_id as string) ?? '';
          const allowed = (req.params?.allowed as boolean) ?? false;
          if (pendingDeferred && pendingDeferred.toolUseId === requestId) {
            pendingDeferred.resolve(allowed);
            pendingDeferred = null;
          }
          ws.send(makeResponse(req.id, { ok: true }));
          break;
        }

        // ── question.respond ─────────────────────────────
        case 'question.respond': {
          ws.send(makeResponse(req.id, { ok: true }));
          break;
        }

        // ── session.list ─────────────────────────────────
        case 'session.list': {
          const sessions = sessionManager.list().map((s: any) => ({
            id: s.id,
            title: s.title || 'Untitled',
            turnCount: s.turnCount || 0,
            model: s.model || '',
            createdAt:
              s.createdAt instanceof Date
                ? s.createdAt.getTime()
                : Date.now(),
          }));
          ws.send(makeResponse(req.id, { sessions }));
          break;
        }

        // ── session.create ───────────────────────────────
        case 'session.create': {
          const s = sessionManager.create({
            cwd: process.cwd(),
            model: config.model,
          });
          currentSessionId = s.id;
          ws.send(
            makeResponse(req.id, {
              sessionId: s.id,
              title: s.title || 'Untitled',
            }),
          );
          break;
        }

        // ── session.resume ───────────────────────────────
        case 'session.resume': {
          const id = (req.params?.session_id as string) ?? '';
          const s = sessionManager.resume(id);
          if (s) {
            currentSessionId = id;
            const messages = s.messages
              .map((m: any) => ({
                role: m.role,
                content: m.content,
              }))
              .filter((m: any) => {
                if (typeof m.content === 'string') return m.content.length > 0;
                if (Array.isArray(m.content)) return m.content.length > 0;
                return false;
              });
            ws.send(
              makeResponse(req.id, {
                sessionId: id,
                title: s.title || 'Untitled',
                messages,
              }),
            );
          } else {
            ws.send(
              makeResponse(req.id, undefined, {
                code: 404,
                message: 'Not found',
              }),
            );
          }
          break;
        }

        // ── session.delete ───────────────────────────────
        case 'session.delete': {
          const id = (req.params?.session_id as string) ?? '';
          try {
            sessionManager.delete(id);
            if (currentSessionId === id) {
              const sessions = sessionManager.list();
              if (sessions.length > 0) {
                currentSessionId = sessions[0]!.id;
              } else {
                const s = sessionManager.create({
                  cwd: process.cwd(),
                  model: config.model,
                });
                currentSessionId = s.id;
              }
            }
            ws.send(
              makeResponse(req.id, {
                deleted: true,
                currentSessionId,
              }),
            );
          } catch (err) {
            ws.send(
              makeResponse(req.id, undefined, {
                code: 500,
                message: (err as Error).message,
              }),
            );
          }
          break;
        }

        // ── session.rename ───────────────────────────────
        case 'session.rename': {
          const id = (req.params?.session_id as string) ?? '';
          const title = (req.params?.title as string) ?? '';
          const s = sessionManager.get(id);
          if (s) {
            s.title = title;
            sessionManager.saveSession(s);
            ws.send(makeResponse(req.id, { ok: true }));
          } else {
            ws.send(
              makeResponse(req.id, undefined, {
                code: 404,
                message: 'Not found',
              }),
            );
          }
          break;
        }

        // ── interrupt ────────────────────────────────────
        case 'interrupt': {
          engine.interrupt();
          ws.send(makeResponse(req.id, { ok: true }));
          break;
        }

        // ── gateway.status ───────────────────────────────
        case 'gateway.status': {
          ws.send(
            makeResponse(req.id, {
              model: config.model,
              provider: (config as any).providerName,
              sessionId: currentSessionId,
            }),
          );
          break;
        }

        // ── Unknown ──────────────────────────────────────
        default:
          ws.send(
            makeResponse(req.id, undefined, {
              code: -32601,
              message: `Unknown method: ${req.method}`,
            }),
          );
      }
    }
  });

  wss.on('error', (err: Error) => {
    process.stderr.write(`[desktop-gateway] WebSocket error: ${err.message}\n`);
  });

  // Keep alive
  setInterval(() => {}, 10_000).unref();

  process.stderr.write(
    `[desktop-gateway] listening on ws://127.0.0.1:${port}\n`,
  );
}
