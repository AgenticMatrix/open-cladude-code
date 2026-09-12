/**
 * Coderix Desktop — Renderer Entry Point
 *
 * Bootstraps the React application inside the Electron renderer process.
 * Imports global styles before any component rendering to prevent FOUC.
 */

import React from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import './styles/variables.css';
import './styles/globals.css';
import 'katex/dist/katex.min.css';

// ---------------------------------------------------------------------------
// Type augmentation for the coderixAPI exposed via preload contextBridge
// ---------------------------------------------------------------------------

declare global {
  interface CoderixQuestionRequest {
    toolUseId: string;
    toolName: string;
    questions: Array<{
      header: string;
      question: string;
      options?: Array<{ label: string; description: string }>;
      multiSelect?: boolean;
    }>;
  }

  interface Window {
    coderixAPI: {
      query: { submit(query: string, sessionId?: string): Promise<{ status: string }>; interrupt(): Promise<{ status: string }> };
      session: { create(opts?: { title?: string; cwd?: string; model?: string }): Promise<{ id: string; title: string; turnCount: number }>; list(): Promise<unknown[]>; get(sessionId: string): Promise<unknown>; load(sessionId: string): Promise<unknown>; fork(sessionId: string): Promise<unknown>; delete(sessionId: string): Promise<{ status: string }>; setModel(model: string): Promise<{ status: string; model: string }> };
      permission: { approve(toolUseId: string): Promise<{ status: string }>; approveSession(toolUseId: string): Promise<{ status: string }>; approveAlways(toolUseId: string): Promise<{ status: string }>; deny(toolUseId: string): Promise<{ status: string }>; setMode(mode: string): Promise<{ mode: string }> };
      question: { answer(toolUseId: string, answers: Record<string, string | string[]>): Promise<{ status: string }> };
      fs: { readFile(filePath: string): Promise<{ content: string; path: string }>; writeFile(path: string, content: string): Promise<{ status: string; path: string }>; listDir(dirPath: string): Promise<{ path: string; entries: unknown[] }>; watch(watchPath: string): Promise<{ watcherId: string; path: string }> };
      terminal: { create(opts?: { cwd?: string; rows?: number; cols?: number }): Promise<{ terminalId: string }>; write(sessionId: string, data: string): void; resize(sessionId: string, rows: number, cols: number): void; destroy(sessionId: string): void; onData(sessionId: string, callback: (data: string) => void): () => void; onExit(sessionId: string, callback: (exitCode: number) => void): () => void };
      config: { get(): Promise<unknown>; set(key: string, value: unknown): Promise<{ key: string; value: unknown; status: string }>; getModelList(): Promise<unknown[]>; testConnection(baseUrl: string, apiKey?: string): Promise<unknown>; reload(): Promise<{ status: string }> };
      project: { get(): Promise<{ path: string }>; list(): Promise<{ paths: string[] }>; set(path: string): Promise<{ canceled: boolean; path: string }>; select(): Promise<{ canceled: boolean; path: string }> };
      app: { getVersion(): Promise<string>; checkUpdate(): Promise<{ updateAvailable: boolean; currentVersion?: string; version?: string; skipped?: boolean; reason?: string; error?: string }>; quit(): void };
      git: {
        status(): Promise<{ branch: string; files: Array<{ file: string; type: string; code: string }>; commits: Array<{ hash: string; message: string; graph: string; refs: string }> }>;
        diff(file: string, staged?: boolean): Promise<{ diff: string; error?: string }>;
        log(maxCount?: number): Promise<{ commits: Array<{ hash: string; message: string }> }>;
        show(hash: string): Promise<{ diff: string; files: Array<{ file: string; type: string }>; error?: string }>;
        stage(file?: string, all?: boolean): Promise<{ status: string }>;
        unstage(file?: string, all?: boolean): Promise<{ status: string }>;
        commit(message: string): Promise<{ status: string; error?: string }>;
      };
      onStreamEvent(callback: (event: unknown) => void): () => void;
      onPermissionRequest(callback: (req: unknown) => void): () => void;
      onStateChange(callback: (change: unknown) => void): () => void;
      onQuestionRequest(callback: (req: CoderixQuestionRequest) => void): () => void;
    };
  }
}

// ---------------------------------------------------------------------------
// Global error capture for debugging
// ---------------------------------------------------------------------------

window.addEventListener('error', (event) => {
  console.error('[Global Error]', event.error?.message, event.error?.stack);
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[Unhandled Rejection]', event.reason?.message, event.reason?.stack);
});

// ---------------------------------------------------------------------------
// Mount
// ---------------------------------------------------------------------------

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element #root not found');
}

const root = createRoot(container);
root.render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
