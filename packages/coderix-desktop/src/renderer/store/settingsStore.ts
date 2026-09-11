import { create } from 'zustand';
import { getConfig, setConfig } from '../ipc-client.js';
import type { PermissionMode, Theme } from './uiStore.js';

// ---------------------------------------------------------------------------
// UI-side settings shape (SettingsView tabs)
// ---------------------------------------------------------------------------

export interface ModelConfig {
  name: string;
  temperature: number;
  maxTokens: number;
  maxContext: number;
  topP: number;
  cachePrice: number;
  inputPrice: number;
  outputPrice: number;
}

export interface ProviderConfig {
  name: string;
  apiKey: string;
  baseUrl: string;
  models: ModelConfig[];
  connected: boolean;
}

export interface SettingsData {
  providers: ProviderConfig[];
  defaultModel: string;
  defaultPermissionMode: PermissionMode;
  theme: Theme;
  mcpServers: Array<{ name: string; url: string; enabled: boolean }>;
  engine: AgentEngine;
}

export type AgentEngine = 'coderix' | 'claude-code';

// ---------------------------------------------------------------------------
// Core-side settings shape (from ~/.coderix/settings.json via loadSettings())
// ---------------------------------------------------------------------------

interface CoreModelItem {
  name: string;
  price?: {
    input: number;
    output: number;
    cache_read_input?: number;
    currency?: string;
    unit?: number;
    concurrency?: number;
    max_context?: number;
  };
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

interface CoreModelEntry {
  model: Array<string | CoreModelItem>;
  provider?: string;
  base_url?: string;
  auth_token_env?: string;
  max_tokens?: number;
}

interface CoderSettings {
  model_list?: CoreModelEntry[];
  default_model?: string;
  theme?: string;
  max_tokens?: number;
  env?: Record<string, string>;
  web_search?: unknown;
  engine?: string;
  default_permission_mode?: 'auto' | 'ask' | 'plan' | 'low';
}

// ---------------------------------------------------------------------------
// Adapters: Core ↔ UI
// ---------------------------------------------------------------------------

/** Detect default placeholder API keys that ship with Coderix. */
function isPlaceholderKey(key: string): boolean {
  const upper = key.toUpperCase();
  return (
    upper === 'LOCAL_NO_KEY' ||
    upper.startsWith('YOUR_') ||
    upper.startsWith('SK-YOUR-')
  );
}

/** Resolve a bare default_model (e.g. "deepseek-v4-pro") to "provider/model" form. */
function qualifyDefaultModel(config: CoderSettings): string {
  const raw = config.default_model ?? '';
  if (!raw || raw.includes('/')) return raw;
  const owner = config.model_list?.find((entry) =>
    entry.model?.some((m) => (typeof m === 'string' ? m : m.name) === raw),
  );
  return owner?.provider ? `${owner.provider}/${raw}` : raw;
}

function settingsToUI(config: CoderSettings): SettingsData {
  return {
    providers:
      config.model_list?.map((entry) => ({
        name: entry.provider ?? 'unknown',
        apiKey: entry.auth_token_env ?? '',
        baseUrl: entry.base_url ?? '',
        models:
          entry.model?.map((m) => {
            const item = typeof m === 'string' ? { name: m } : m;
            return {
              name: item.name,
              temperature: item.temperature ?? 0.7,
              maxTokens: item.max_tokens ?? entry.max_tokens ?? config.max_tokens ?? 32768,
              maxContext: item.price?.max_context ?? 1000000,
              topP: item.top_p ?? 1.0,
              cachePrice: item.price?.cache_read_input ?? 0,
              inputPrice: item.price?.input ?? 0,
              outputPrice: item.price?.output ?? 0,
            };
          }) ?? [],
        connected: !!(entry.auth_token_env && entry.auth_token_env.length > 0 && !isPlaceholderKey(entry.auth_token_env)),
      })) ?? [],
    defaultModel: qualifyDefaultModel(config),
    defaultPermissionMode: (config.default_permission_mode as PermissionMode) ?? 'ask',
    theme: (config.theme as Theme) ?? 'light',
    mcpServers: [],
    engine: (config.engine === 'claude-code' ? 'claude-code' : 'coderix'),
  };
}

function uiToSettings(data: SettingsData): Partial<CoderSettings> {
  return {
    theme: data.theme,
    default_model: data.defaultModel,
    engine: data.engine,
    default_permission_mode: data.defaultPermissionMode,
    model_list: data.providers.map((p) => ({
      provider: p.name.toLowerCase(),
      base_url: p.baseUrl,
      auth_token_env: p.apiKey,
      model: p.models.map((m) => ({
        name: m.name,
        temperature: m.temperature,
        top_p: m.topP,
        max_tokens: m.maxTokens,
        price: {
          input: m.inputPrice,
          output: m.outputPrice,
          cache_read_input: m.cachePrice,
          max_context: m.maxContext,
        },
      })),
    })),
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface SettingsStore {
  settings: SettingsData | null;
  loading: boolean;
  error: string | null;
  load: () => Promise<void>;
  save: (data: SettingsData) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Mainstream model catalog per provider
// ---------------------------------------------------------------------------

export const PROVIDER_CATALOG: Record<string, { baseUrl: string; models: string[]; isRelay?: boolean }> = {
  anthropic: {
    baseUrl: 'https://api.anthropic.com',
    models: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-5'],
  },
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'gpt-5.5'],
  },
  // ── 中转站 / Relay — one key + one URL, any model ──
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['anthropic/claude-sonnet-5', 'openai/gpt-5', 'google/gemini-3-flash'],
    isRelay: true,
  },
  glm: {
    baseUrl: 'https://open.bigmodel.cn/api/anthropic',
    models: ['glm-5', 'glm-5.2', 'glm-5.3'],
  },
  deepseek: {
    baseUrl: 'https://api.deepseek.com/anthropic',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro'],
  },
  google: {
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    models: ['gemini-3-flash', 'gemini-3-flash-lite', 'gemini-3-pro'],
  },
  grok: {
    baseUrl: 'https://api.x.ai/v1',
    models: ['grok-4', 'grok-4-fast', 'grok-4-mini'],
  },
  qwen: {
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3.8-flash', 'qwen3.8-max-0902'],
  },
  moonshot: {
    baseUrl: 'https://api.moonshot.cn/anthropic',
    models: ['kimi-k2.6', 'kimi-k2.7-code', 'kimi-k3', 'kimi-k2.7-code-highspeed'],
  },
  tencent: {
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/anthropic',
    models: ['hunyuan-2.0-instruct-20251111', 'hunyuan-2.0-thinking-20251109'],
  },
  bytedance: {
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    models: ['doubao-seed-2.0-code', 'doubao-seed-2.0-lite', 'doubao-seed-2.0-pro', 'deepseek-r1-250120', 'doubao-1-5-pro-32k-character-250228', 'seed-2.5'],
  },
  minimax: {
    baseUrl: 'https://api.minimaxi.com/anthropic',
    models: ['MiniMax-M2.7', 'MiniMax-M2.7-highspeed', 'MiniMax-M3'],
  },
  local: {
    baseUrl: 'http://localhost:8000/v1',
    models: ['local-llama3-70b', 'local-qwen-32b', 'local-mistral'],
  },
};

export function getProviderModels(providerName: string): string[] {
  const key = providerName.toLowerCase();
  return PROVIDER_CATALOG[key]?.models ?? ['default-model'];
}

export function getProviderBaseUrl(providerName: string): string {
  const key = providerName.toLowerCase();
  return PROVIDER_CATALOG[key]?.baseUrl ?? 'https://api.example.com';
}

/** Map a catalog provider's model names to full ModelConfig entries with defaults. */
export function toModelConfigs(names: string[], maxTokens = 32768): ModelConfig[] {
  return names.map((name) => ({
    name,
    temperature: 0.7,
    maxTokens,
    maxContext: 1000000,
    topP: 1.0,
    cachePrice: 0,
    inputPrice: 0,
    outputPrice: 0,
  }));
}

export const useSettingsStore = create<SettingsStore>()((set) => ({
  settings: null,
  loading: false,
  error: null,

  load: async () => {
    set({ loading: true, error: null });
    try {
      const raw = (await getConfig()) as Record<string, unknown>;
      // Check if settings were saved as a nested 'settings' key (old bug)
      if (raw && raw.settings && typeof raw.settings === 'object') {
        // Old format: settings were saved under a nested key
        const ui = raw.settings as unknown as SettingsData;
        set({ settings: ui, loading: false });
      } else if (raw && raw.model_list) {
        // New format: core CoderSettings at root level
        set({ settings: settingsToUI(raw as unknown as CoderSettings), loading: false });
      } else {
        // Empty/unknown — use defaults, will populate on save
        set({
          settings: {
            providers: [],
            defaultModel: '',
            defaultPermissionMode: 'auto',
            theme: 'light',
            mcpServers: [],
            engine: 'coderix',
          },
          loading: false,
        });
      }
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },

  save: async (data: SettingsData) => {
    set({ loading: true, error: null });
    try {
      const toSave = uiToSettings(data);
      // Pass empty key to trigger top-level merge in CONFIG_SET handler
      await setConfig('', toSave);
      // Re-run through settingsToUI to recalculate connected flags
      const refreshed = settingsToUI(toSave as CoderSettings);
      set({ settings: refreshed, loading: false });
      // Hot-reload: reinitialize QueryEngine with new model/API key
      if (window.coderixAPI?.config?.reload) {
        await window.coderixAPI.config.reload();
      }
    } catch (err) {
      set({ error: (err as Error).message, loading: false });
    }
  },
}));
