import React, { useState, useEffect, useCallback } from 'react';
import { Bot, Palette, ShieldCheck, RefreshCw, X, Plus, ChevronRight, Sun, Moon, Cpu } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useUIStore, type PermissionMode, type Theme } from '../../store/uiStore.js';
import { useSettingsStore, type SettingsData, type ProviderConfig, type AgentEngine } from '../../store/settingsStore.js';
import ProviderEditor from './ProviderEditor.js';
import { providerLabel, ProviderLogo } from './providerMeta.js';

// ── Types ──────────────────────────────────────────────────

type SettingsTab = 'model' | 'engine' | 'appearance' | 'permissions' | 'update';

/** "provider/model" for the dropdown label/value, without double-prefixing relay models. */
function qualifiedModelName(provider: string, model: string): string {
  return model.includes('/') ? model : `${provider}/${model}`;
}

interface NavItem {
  id: SettingsTab;
  label: string;
  icon: LucideIcon;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'model', label: '模型', icon: Bot },
  { id: 'engine', label: '智能体引擎', icon: Cpu },
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'permissions', label: '权限', icon: ShieldCheck },
  { id: 'update', label: '更新', icon: RefreshCw },
];

// ── Component ──────────────────────────────────────────────

export default function SettingsView({ onClose }: { onClose?: () => void }): React.ReactElement {
  const [activeTab, setActiveTab] = useState<SettingsTab>('model');
  const [draft, setDraft] = useState<SettingsData | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');
  const [appVersion, setAppVersion] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateMsg, setUpdateMsg] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const { setTheme, setPermissionMode } = useUIStore();
  const { settings, loading, load, save } = useSettingsStore();

  // Reload from file every time settings panel opens
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    window.coderixAPI?.app?.getVersion?.()
      .then((version) => setAppVersion(version))
      .catch(() => {});
  }, []);

  // Sync from store to draft whenever store updates (e.g. after load completes)
  useEffect(() => {
    if (settings) setDraft(JSON.parse(JSON.stringify(settings)));
  }, [settings]);

  // ── Draft helpers ────────────────────────────────────────

  const updateDraft = useCallback((patch: Partial<SettingsData> & { providers?: ProviderConfig[] }) => {
    setDraft((d) => d ? { ...d, ...patch } : d);
  }, []);

  const updateProviderInDraft = useCallback((i: number, patch: Partial<ProviderConfig>) => {
    setDraft((d) => {
      if (!d) return d;
      return { ...d, providers: d.providers.map((p, idx) => i === idx ? { ...p, ...patch } : p) };
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setSaveMsg('');
    try {
      await save(draft);
      setSaveMsg('已保存');
      setTimeout(() => setSaveMsg(''), 2000);
    } catch (e) {
      setSaveMsg('保存失败: ' + (e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, save]);

  const addProvider = () => {
    if (!draft) return;
    const idx = draft.providers.length;
    setDraft({ ...draft, providers: [...draft.providers, { name: '', apiKey: '', baseUrl: '', models: [], connected: false }] });
    setIsCreating(true);
    setEditingIndex(idx);
  };

  const removeProvider = (i: number) => {
    setDraft((d) => (d ? { ...d, providers: d.providers.filter((_, idx) => idx !== i) } : d));
  };

  const handleEditorBack = () => {
    if (isCreating && editingIndex !== null && draft) {
      const p = draft.providers[editingIndex];
      if (p && !p.name && p.models.length === 0) {
        setDraft({ ...draft, providers: draft.providers.filter((_, idx) => idx !== editingIndex) });
      }
    }
    setIsCreating(false);
    setEditingIndex(null);
  };

  const handleDeleteProvider = () => {
    if (editingIndex !== null) removeProvider(editingIndex);
    setEditingIndex(null);
  };

  const handleCheckUpdate = useCallback(async () => {
    if (!window.coderixAPI?.app?.checkUpdate) return;
    setCheckingUpdate(true);
    setUpdateMsg('');
    try {
      const result = await window.coderixAPI.app.checkUpdate();
      if (result.updateAvailable) {
        setUpdateMsg(`发现新版本 ${result.version ?? ''}`.trim());
      } else if (result.error) {
        setUpdateMsg(result.error);
      } else if (result.skipped) {
        setUpdateMsg('开发环境未执行更新检查');
      } else {
        setUpdateMsg('已是最新版本');
      }
    } catch (err) {
      setUpdateMsg((err as Error).message);
    } finally {
      setCheckingUpdate(false);
    }
  }, []);

  // ── Inline styles (form controls keep the warm Coderix tokens) ──
  const S = {
    card: { padding: '20px', borderRadius: 'var(--radius-lg)', background: 'var(--color-bg-secondary)', border: '1px solid var(--color-separator)' } as React.CSSProperties,
    cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' } as React.CSSProperties,
    badge: (ok: boolean) => ({ fontSize: 'var(--text-xs)', padding: '2px 10px', borderRadius: 'var(--radius-full)', background: ok ? 'var(--color-success)' : 'var(--color-text-tertiary)', color: '#fff', fontWeight: 500 } as React.CSSProperties),
    label: { display: 'block', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginBottom: '4px', marginTop: '12px' } as React.CSSProperties,
    input: { width: '100%', padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-separator)', background: 'var(--color-input-bg)', color: 'var(--color-text-primary)', fontSize: 'var(--text-sm)', fontFamily: 'var(--font-mono)', boxSizing: 'border-box' as const } as React.CSSProperties,
    select: { width: '100%', padding: '8px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--color-separator)', background: 'var(--color-input-bg)', color: 'var(--color-text-primary)', fontSize: 'var(--text-sm)', boxSizing: 'border-box' as const } as React.CSSProperties,
    themeBtn: (active: boolean, t: Theme) => ({ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px', padding: '12px 24px', borderRadius: 'var(--radius-lg)', border: active ? '2px solid var(--color-brand)' : '1px solid var(--color-separator)', background: t === 'light' ? '#FAF9F5' : '#262624', color: t === 'light' ? '#29261B' : '#EDEBE0', cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: active ? 600 : 400, minWidth: '120px' } as React.CSSProperties),
    permBtn: (active: boolean) => ({ textAlign: 'left' as const, padding: '12px 16px', borderRadius: 'var(--radius-lg)', border: active ? '2px solid var(--color-brand)' : '1px solid var(--color-separator)', background: 'var(--color-bg-secondary)', cursor: 'pointer', marginBottom: '8px', width: '100%' }),
    engineBtn: (active: boolean) => ({ textAlign: 'left' as const, padding: '14px 16px', borderRadius: 'var(--radius-lg)', border: active ? '2px solid var(--color-brand)' : '1px solid var(--color-separator)', background: 'var(--color-bg-secondary)', cursor: 'pointer', marginBottom: '12px', width: '100%', display: 'flex', alignItems: 'center', gap: '12px' } as React.CSSProperties),
    saveBtn: { padding: '6px 16px', borderRadius: 'var(--radius-md)', background: 'var(--color-brand)', color: '#fff', border: 'none', cursor: 'pointer', fontSize: 'var(--text-sm)', fontWeight: 500 } as React.CSSProperties,
    addBtn: { width: '100%', padding: '12px', borderRadius: 'var(--radius-md)', border: '1px dashed var(--color-separator)', background: 'transparent', color: 'var(--color-text-secondary)', cursor: 'pointer', fontSize: 'var(--text-sm)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '8px' } as React.CSSProperties,
  };

  const sectionTitle: React.CSSProperties = { fontSize: 'var(--text-xs)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: 'var(--tracking-wider)', color: 'var(--color-text-secondary)' };
  const sectionDesc: React.CSSProperties = { marginTop: '4px', fontSize: 'var(--text-sm)', color: 'var(--color-text-secondary)' };

  // Derive the current default-model selection (provider + model) from the single
  // "provider/model" string so the two-level picker stays in sync with the draft.
  const defaultSel = (() => {
    const dm = draft?.defaultModel ?? '';
    if (!dm) return { provider: '', model: '' };
    for (const p of draft?.providers ?? []) {
      for (const m of p.models) {
        if (qualifiedModelName(p.name, m.name) === dm) return { provider: p.name, model: m.name };
      }
    }
    return { provider: '', model: '' };
  })();
  const defaultProviderModels = draft ? (draft.providers.find((p) => p.name === defaultSel.provider)?.models ?? []) : [];

  return (
    <div className="flex h-full flex-col bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
      {/* Header */}
      <header className="flex flex-shrink-0 items-center justify-between border-b border-[var(--color-separator)] px-5 py-3">
        <h2 className="text-base font-semibold">设置</h2>
        <div className="flex items-center gap-2">
          {saveMsg && (
            <span className="text-xs" style={{ color: saveMsg.includes('失败') ? 'var(--color-danger)' : 'var(--color-success)' }}>{saveMsg}</span>
          )}
          <button onClick={handleSave} disabled={saving} style={{ ...S.saveBtn, opacity: saving ? 0.6 : 1 }}>{saving ? '保存中...' : '保存'}</button>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="关闭"
              className="ml-1 flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
            >
              <X size={16} />
            </button>
          )}
        </div>
      </header>

      {loading || !draft ? (
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--color-text-tertiary)]">加载设置中...</div>
      ) : (
        <div className="flex min-h-0 flex-1">
          {/* Sidebar — left menu */}
          <aside className="flex w-56 flex-shrink-0 flex-col border-r border-[var(--color-separator)] bg-[var(--color-bg-secondary)]">
            <nav className="flex flex-col gap-1 p-3">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors duration-150 ${
                      isActive
                        ? 'bg-[var(--color-brand-muted)] text-[var(--color-brand)]'
                        : 'text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)]'
                    }`}
                  >
                    <Icon size={16} className="flex-shrink-0" />
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </aside>

          {/* Content — right panel */}
          <main className="min-w-0 flex-1 overflow-y-auto px-6 py-6">
            {activeTab === 'model' && (isCreating || editingIndex !== null ? (
              <ProviderEditor
                provider={draft.providers[editingIndex!] ?? { name: '', apiKey: '', baseUrl: '', models: [], connected: false }}
                isNew={isCreating}
                onChange={(p) => updateProviderInDraft(editingIndex!, p)}
                onBack={handleEditorBack}
                onDelete={isCreating ? undefined : handleDeleteProvider}
              />
            ) : (
              <div className="space-y-5">
                <div>
                  <h3 style={sectionTitle}>默认模型</h3>
                  <p style={sectionDesc}>选择全局默认模型，先选 Provider，再选具体模型。</p>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '8px' }}>
                    <label style={{ ...S.label, marginTop: 0 }}>
                      Provider
                      <select
                        value={defaultSel.provider}
                        onChange={(e) => {
                          const prov = draft.providers.find((p) => p.name === e.target.value);
                          const first = prov?.models[0];
                          updateDraft({ defaultModel: first ? qualifiedModelName(prov!.name, first.name) : '' });
                        }}
                        style={{ ...S.select, marginTop: '4px' }}
                      >
                        <option value="">未选择</option>
                        {draft.providers.filter((p) => p.models.length > 0).map((p) => (
                          <option key={p.name} value={p.name}>{p.name ? providerLabel(p.name) : '未命名 Provider'}</option>
                        ))}
                      </select>
                    </label>
                    <label style={{ ...S.label, marginTop: 0 }}>
                      模型
                      <select
                        value={defaultSel.model}
                        onChange={(e) => updateDraft({ defaultModel: qualifiedModelName(defaultSel.provider, e.target.value) })}
                        disabled={!defaultSel.provider}
                        style={{ ...S.select, marginTop: '4px', opacity: defaultSel.provider ? 1 : 0.5 }}
                      >
                        <option value="">未选择</option>
                        {defaultProviderModels.map((m) => (
                          <option key={m.name} value={m.name}>{m.name}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                </div>

                <div>
                  <h3 style={sectionTitle}>大模型配置</h3>
                  <p style={sectionDesc}>管理 Provider 与模型。</p>
                  <div className="mt-2 space-y-2">
                    {draft.providers.map((p, i) => (
                      <button
                        key={i}
                        type="button"
                        onClick={() => { setIsCreating(false); setEditingIndex(i); }}
                        className="flex w-full items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-separator)] bg-[var(--color-bg-secondary)] px-4 py-3 text-left transition-colors hover:bg-[var(--color-bg-tertiary)]"
                      >
                        <ProviderLogo provider={p.name} size={28} />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-[var(--color-text-primary)]">{p.name ? providerLabel(p.name) : '未命名 Provider'}</span>
                          <span className="block text-xs text-[var(--color-text-secondary)]">{p.models.length} 个模型</span>
                        </span>
                        <span style={S.badge(p.connected)}>{p.connected ? '已配置' : '未配置'}</span>
                        <ChevronRight size={16} className="text-[var(--color-text-tertiary)]" />
                      </button>
                    ))}
                    <button style={S.addBtn} onClick={addProvider}><Plus size={16} />新增 Provider</button>
                  </div>
                </div>
              </div>
            ))}

            {activeTab === 'engine' && (
              <div className="space-y-5">
                <div>
                  <h3 style={sectionTitle}>智能体引擎</h3>
                  <p style={sectionDesc}>选择执行对话的底层引擎，保存后自动重载配置并生效。</p>
                </div>
                {([
                  { id: 'coderix' as AgentEngine, title: 'Coderix', desc: '内置引擎，复用当前模型 Provider、权限与工具体系。', badge: '内置' },
                  { id: 'claude-code' as AgentEngine, title: 'Claude Code', desc: '使用官方 Claude Code SDK，由本机 claude CLI 驱动（需已安装并登录）。', badge: 'SDK' },
                ]).map(({ id, title, desc, badge }) => (
                  <button key={id} onClick={() => updateDraft({ engine: id })} style={S.engineBtn((draft.engine ?? 'coderix') === id)}>
                    <Cpu size={18} className="flex-shrink-0" style={{ color: (draft.engine ?? 'coderix') === id ? 'var(--color-brand)' : 'var(--color-text-tertiary)' }} />
                    <div className="min-w-0 flex-1">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{title}</span>
                        <span style={{ fontSize: 'var(--text-xs)', padding: '1px 8px', borderRadius: 'var(--radius-full)', background: 'var(--color-bg-tertiary)', color: 'var(--color-text-secondary)' }}>{badge}</span>
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginTop: '4px' }}>{desc}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}

            {activeTab === 'appearance' && (
              <div className="space-y-5">
                <div>
                  <h3 style={sectionTitle}>外观</h3>
                  <p style={sectionDesc}>选择应用的主题样式。</p>
                </div>
                <div style={{ display: 'flex', gap: '12px' }}>
                  {(['light', 'dark'] as Theme[]).map(t => (
                    <button key={t} onClick={() => { setTheme(t); updateDraft({ theme: t }); }} style={S.themeBtn(draft.theme === t, t)}>
                      {t === 'light' ? <Sun size={16} /> : <Moon size={16} />}
                      <span>{t === 'light' ? '浅色' : '深色'}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'permissions' && (
              <div className="space-y-5">
                <div>
                  <h3 style={sectionTitle}>权限</h3>
                  <p style={sectionDesc}>控制 Agent 执行工具操作时的默认行为。</p>
                </div>
                <div>
                  {([
                    { mode: 'plan' as PermissionMode, label: '先出计划再执行', desc: 'Agent 先制定计划，您审批后再执行。' },
                    { mode: 'ask' as PermissionMode, label: '每次操作前询问', desc: '每个工具调用都需要您确认。' },
                    { mode: 'auto' as PermissionMode, label: '自动执行', desc: 'Agent 自动执行所有操作，不询问。推荐。' },
                  ]).map(({ mode, label, desc }) => (
                    <button key={mode} onClick={() => { setPermissionMode(mode); updateDraft({ defaultPermissionMode: mode }); window.coderixAPI?.permission?.setMode?.(mode).catch(() => {}); }} style={S.permBtn(draft.defaultPermissionMode === mode)}>
                      <div style={{ fontWeight: 600, fontSize: 'var(--text-sm)' }}>{label}</div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', marginTop: '4px' }}>{desc}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'update' && (
              <div className="space-y-5">
                <div>
                  <h3 style={sectionTitle}>更新</h3>
                  <p style={sectionDesc}>检查应用更新与当前版本信息。</p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
                  <button onClick={handleCheckUpdate} disabled={checkingUpdate} style={{ ...S.saveBtn, opacity: checkingUpdate ? 0.6 : 1 }}>
                    {checkingUpdate ? '检查中...' : '检查更新'}
                  </button>
                  {appVersion && (
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--color-text-tertiary)' }}>
                      版本 {appVersion}
                    </span>
                  )}
                  {updateMsg && (
                    <span style={{ fontSize: 'var(--text-xs)', color: updateMsg.includes('发现') ? 'var(--color-success)' : 'var(--color-text-secondary)' }}>
                      {updateMsg}
                    </span>
                  )}
                </div>
              </div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

SettingsView.displayName = 'SettingsView';
