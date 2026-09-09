import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SlashCommand } from '../types.js';

const streamingBusy = 'Agent is currently streaming. Wait for it to finish, then try again.';

function maskValue(v: string): string {
  if (!v || v.startsWith('YOUR_') || v === 'LOCAL_NO_KEY') return '⚠ unconfigured';
  if (v.length <= 8) return '***';
  return v.slice(0, 4) + '...' + v.slice(-4);
}

/** Indent + key padded to COL_WIDTH, then value. */
const COL = 24;
function row(indent: number, key: string, value: string): string {
  return ' '.repeat(indent) + (key + ' ').padEnd(COL - indent) + value;
}

export const configCommands: SlashCommand[] = [
  {
    name: 'config',
    aliases: ['cfg'],
    help: 'read or modify settings in ~/.coderix/settings.json',
    usage: '/config [set <key> <value>]',
    run: (arg, ctx) => {
      if (ctx.isStreaming) {
        ctx.sys(streamingBusy);
        return;
      }

      const trimmed = arg.trim();
      const parts = trimmed.split(/\s+/);

      if (!trimmed) {
        // ── Direct display (no AI needed) ──
        const settingsPath = join(homedir(), '.coderix', 'settings.json');
        if (!existsSync(settingsPath)) {
          ctx.sys('No settings file found at ~/.coderix/settings.json.\nRun the app once to generate default settings.');
          return;
        }

        let settings: Record<string, unknown>;
        try {
          settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        } catch {
          ctx.sys('Failed to parse ~/.coderix/settings.json.');
          return;
        }

        const lines: string[] = [];
        const theme = settings.theme ?? 'not set';
        const defaultModel = settings.default_model ?? 'not set';
        const maxTokens = settings.max_tokens ?? '32768 (default)';
        const concurrency = settings.max_tool_concurrency ?? '32 (default)';

        lines.push('Appearance');
        lines.push(row(2, 'theme', String(theme)));
        lines.push('');
        lines.push('Model');
        lines.push(row(2, 'default_model', String(defaultModel)));
        lines.push('');
        lines.push('Performance');
        lines.push(row(2, 'max_tokens', String(maxTokens)));
        lines.push(row(2, 'max_tool_concurrency', String(concurrency)));
        lines.push('');

        // Model providers
        const modelList = settings.model_list as Array<Record<string, unknown>> | undefined;
        if (modelList && modelList.length > 0) {
          lines.push('Model Providers');
          for (let i = 0; i < modelList.length; i++) {
            const entry = modelList[i]!;
            const provider = String(entry.provider ?? 'unknown');
            const baseUrl = String(entry.base_url ?? 'not set');
            const authToken = String(entry.auth_token_env ?? '');
            const models = entry.model as Array<string | { name: string }> | undefined;
            const modelNames = models
              ? models.map((m) => (typeof m === 'string' ? m : m.name)).join(', ')
              : 'none';

            lines.push(`  [${provider}]`);
            lines.push(row(4, 'base_url', baseUrl));
            lines.push(row(4, 'models', modelNames));
            lines.push(row(4, 'auth_token_env', maskValue(authToken)));
            if (entry.proxy) lines.push(row(4, 'proxy', String(entry.proxy)));
          }
          lines.push('');
        }

        // Web search
        const ws = settings.web_search as Record<string, unknown> | undefined;
        if (ws) {
          lines.push('Web Search');
          lines.push(row(2, 'provider', String(ws.provider ?? 'not set')));
          lines.push(row(2, 'brave_api_key', maskValue(String(ws.brave_api_key ?? ''))));
          lines.push(row(2, 'bing_api_key', maskValue(String(ws.bing_api_key ?? ''))));
          if (ws.proxy) lines.push(row(2, 'proxy', String(ws.proxy)));
          lines.push('');
        }

        // Advanced
        const defaultTeam = settings.default_team;
        if (defaultTeam) {
          lines.push('Advanced');
          lines.push(row(2, 'default_team', String(defaultTeam)));
          lines.push('');
        }

        lines.push('─'.repeat(50));
        lines.push('Change a setting: /config set <key> <value>');
        lines.push('Example: /config set theme dark');

        ctx.sys(lines.join('\n'));
        return;
      }

      if (parts[0] === 'set' && parts.length >= 3) {
        const key = parts[1];
        const value = parts.slice(2).join(' ');
        ctx.send(
          [
            `Update the setting "${key}" to "${value}" in ~/.coderix/settings.json.`,
            '',
            'Follow these steps:',
            '1. Read the current ~/.coderix/settings.json file',
            '2. Parse it as JSON and locate the key "' + key + '"',
            '   - For top-level keys (e.g., "theme", "max_tokens", "default_model"), update directly',
            '3. Convert the value appropriately:',
            '   - "true" or "false" → boolean',
            '   - Pure numeric string → number',
            '   - Otherwise → keep as string',
            '4. The new value is: "' + value + '"',
            '5. Write the updated JSON back to ~/.coderix/settings.json with 2-space indentation',
            '6. Read the file back and confirm the change was applied successfully',
            '7. Show a brief confirmation: "Updated <key> to <value>"',
            '',
            'If the key does not exist, add it at the top level of the JSON.',
            'If the file does not exist or is invalid JSON, report the error clearly.',
          ].join('\n'),
        );
        return;
      }

      ctx.sys(
        [
          'Usage:',
          '  /config                    Display current settings',
          '  /config set <key> <value>  Update a setting',
          '',
          'Example: /config set theme dark',
        ].join('\n'),
      );
    },
  },
];
