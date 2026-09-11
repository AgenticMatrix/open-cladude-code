import React, { useMemo, useState } from 'react';
import { ArrowLeft, ChevronDown, ExternalLink, Plus, Trash2, X } from 'lucide-react';
import {
  PROVIDER_CATALOG,
  getProviderModels,
  getProviderBaseUrl,
  toModelConfigs,
  type ProviderConfig,
  type ModelConfig,
} from '../../store/settingsStore.js';
import { PROVIDER_DOCS, providerLabel, ProviderLogo } from './providerMeta.js';

interface ProviderEditorProps {
  provider: ProviderConfig;
  isNew: boolean;
  onChange: (next: ProviderConfig) => void;
  onBack: () => void;
  onDelete?: () => void;
}

const EMPTY_FIELDS: ModelConfig = {
  name: '',
  temperature: 0.7,
  maxTokens: 32768,
  maxContext: 1000000,
  topP: 1.0,
  cachePrice: 0,
  inputPrice: 0,
  outputPrice: 0,
};

// Inline form-control styles (mirrors SettingsView's warm Coderix tokens).
const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 12px',
  borderRadius: 'var(--radius-md)',
  border: '1px solid var(--color-separator)',
  background: 'var(--color-input-bg)',
  color: 'var(--color-text-primary)',
  fontSize: 'var(--text-sm)',
  fontFamily: 'var(--font-mono)',
  boxSizing: 'border-box',
};
const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 'var(--text-xs)',
  color: 'var(--color-text-secondary)',
  marginBottom: '4px',
  marginTop: '12px',
};

/**
 * Provider-level editor: base URL + API key are shared across the provider's
 * models (edited once here). Below, a dropdown lists the provider's models —
 * pick one to edit its per-model parameters (temperature / … / pricing), hover
 * a row to reveal a delete ×, or add a new model. Changes flow up to the draft
 * immediately via `onChange`; persistence happens via the top-level 保存 button.
 */
export default function ProviderEditor({ provider, isNew, onChange, onBack, onDelete }: ProviderEditorProps) {
  const [name, setName] = useState(provider.name);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [apiKey, setApiKey] = useState(provider.apiKey);
  const [models, setModels] = useState<ModelConfig[]>(provider.models);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(provider.models.length > 0 ? 0 : null);
  const [fields, setFields] = useState<ModelConfig>(provider.models[0] ?? { ...EMPTY_FIELDS });
  const [open, setOpen] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [confirmDeleteIndex, setConfirmDeleteIndex] = useState<number | null>(null);
  const [confirmDeleteProvider, setConfirmDeleteProvider] = useState(false);

  const slug = (isNew ? name : provider.name).trim().toLowerCase();
  const selected = selectedIndex !== null ? models[selectedIndex] ?? null : null;
  const adding = selectedIndex === null;

  const emit = (next: Partial<ProviderConfig>) => {
    onChange({ ...provider, name: slug, baseUrl, apiKey, models, ...next });
  };

  const patchFields = (patch: Partial<ModelConfig>) => {
    setFields((f) => ({ ...f, ...patch }));
    if (selectedIndex !== null) {
      const nextModels = models.map((m, i) => (i === selectedIndex ? { ...m, ...patch } : m));
      setModels(nextModels);
      emit({ models: nextModels });
    }
  };

  const selectModel = (index: number | null) => {
    setSelectedIndex(index);
    setOpen(false);
    setConfirmDeleteIndex(null);
    setFields(index !== null ? models[index] ?? { ...EMPTY_FIELDS } : { ...EMPTY_FIELDS });
  };

  const addModel = () => {
    const modelName = fields.name.trim();
    if (!modelName) return;
    const next = [...models, { ...fields, name: modelName }];
    setModels(next);
    emit({ models: next });
    setFields({ ...EMPTY_FIELDS });
    setSelectedIndex(next.length - 1);
  };

  const deleteModel = (index: number) => {
    const next = models.filter((_, i) => i !== index);
    setModels(next);
    emit({ models: next });
    setConfirmDeleteIndex(null);
    if (selectedIndex === index) {
      setSelectedIndex(next.length > 0 ? Math.min(index, next.length - 1) : null);
      setFields(next.length > 0 ? next[Math.min(index, next.length - 1)] : { ...EMPTY_FIELDS });
    } else if (selectedIndex !== null && selectedIndex > index) {
      setSelectedIndex(selectedIndex - 1);
    }
  };

  // New provider: picking a catalog provider auto-fills name + base URL + models.
  const pickCatalogProvider = (key: string) => {
    const isCustom = key === '__custom__';
    setName(isCustom ? '' : key);
    setBaseUrl(isCustom ? '' : getProviderBaseUrl(key));
    const nextModels = isCustom ? [] : toModelConfigs(getProviderModels(key));
    setModels(nextModels);
    setSelectedIndex(nextModels.length > 0 ? 0 : null);
    setFields(nextModels[0] ?? { ...EMPTY_FIELDS });
    emit({
      name: isCustom ? '' : key,
      baseUrl: isCustom ? '' : getProviderBaseUrl(key),
      models: nextModels,
    });
  };

  const docsUrl = PROVIDER_DOCS[slug];

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-[var(--color-separator)] px-5 py-3">
        <button
          type="button"
          onClick={onBack}
          title="返回"
          className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
        >
          <ArrowLeft size={16} />
        </button>
        <ProviderLogo provider={slug || 'custom'} size={28} />
        <span className="flex-1 text-base font-semibold">{isNew ? '新增 Provider' : providerLabel(provider.name)}</span>
        {!isNew && onDelete && (
          confirmDeleteProvider ? (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onDelete}
                className="rounded-[var(--radius-md)] bg-[var(--color-danger)] px-3 py-1 text-xs font-medium text-white"
              >
                确认删除
              </button>
              <button
                type="button"
                onClick={() => setConfirmDeleteProvider(false)}
                className="rounded-[var(--radius-md)] border border-[var(--color-separator)] px-3 py-1 text-xs text-[var(--color-text-secondary)]"
              >
                取消
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDeleteProvider(true)}
              title="删除该 Provider"
              className="flex h-7 w-7 items-center justify-center rounded-[var(--radius-sm)] text-[var(--color-text-tertiary)] hover:bg-[var(--color-danger-muted)] hover:text-[var(--color-danger)] transition-colors"
            >
              <Trash2 size={16} />
            </button>
          )
        )}
      </div>

      {/* Body */}
      <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-6">
        {/* Provider config */}
        <section>
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">Provider 配置</h3>
            {docsUrl && (
              <a
                href={docsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-xs text-[var(--color-brand)] hover:underline"
              >
                参考文档
                <ExternalLink size={13} />
              </a>
            )}
          </div>
          <div
            style={{
              padding: '16px',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-separator)',
              marginTop: '8px',
            }}
          >
            {isNew && (
              <>
                <label style={labelStyle}>Provider 名称</label>
                <select
                  value={PROVIDER_CATALOG[slug] ? slug : '__custom__'}
                  onChange={(e) => pickCatalogProvider(e.target.value)}
                  style={inputStyle}
                >
                  {Object.keys(PROVIDER_CATALOG).map((k) => (
                    <option key={k} value={k}>{providerLabel(k)}</option>
                  ))}
                  <option value="__custom__">自定义 Provider…</option>
                </select>
                {!PROVIDER_CATALOG[slug] && (
                  <>
                    <label style={labelStyle}>自定义名称 (provider slug)</label>
                    <input
                      style={inputStyle}
                      value={name}
                      onChange={(e) => {
                        setName(e.target.value);
                        emit({ name: e.target.value.trim().toLowerCase() });
                      }}
                      placeholder="例如 cohere"
                    />
                  </>
                )}
              </>
            )}

            <label style={{ ...labelStyle, marginTop: isNew ? '12px' : '0' }}>接口地址 (Base URL)</label>
            <input
              style={inputStyle}
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                emit({ baseUrl: e.target.value });
              }}
              placeholder="https://…"
            />

            <label style={labelStyle}>API Key</label>
            <div style={{ display: 'flex', gap: '8px' }}>
              <input
                style={{ ...inputStyle, flex: 1 }}
                type={showKey ? 'text' : 'password'}
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  emit({ apiKey: e.target.value });
                }}
                placeholder="sk-…"
              />
              <button
                type="button"
                onClick={() => setShowKey((s) => !s)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--color-separator)',
                  background: 'var(--color-bg-tertiary)',
                  color: 'var(--color-text-secondary)',
                  cursor: 'pointer',
                  fontSize: 'var(--text-xs)',
                }}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>
        </section>

        {/* Models */}
        <section>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-secondary)]">模型</h3>
          <div
            style={{
              padding: '16px',
              borderRadius: 'var(--radius-lg)',
              background: 'var(--color-bg-secondary)',
              border: '1px solid var(--color-separator)',
              marginTop: '8px',
            }}
          >
            <label style={{ ...labelStyle, marginTop: 0 }}>选择模型</label>
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                style={{
                  ...inputStyle,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  cursor: 'pointer',
                }}
              >
                <span>{selected?.name ?? (adding ? '新增模型…' : '')}</span>
                <ChevronDown size={16} style={{ color: 'var(--color-text-tertiary)' }} />
              </button>
              {open && (
                <div
                  style={{
                    position: 'absolute',
                    top: 'calc(100% + 4px)',
                    left: 0,
                    right: 0,
                    zIndex: 10,
                    background: 'var(--color-input-bg)',
                    border: '1px solid var(--color-separator)',
                    borderRadius: 'var(--radius-md)',
                    boxShadow: 'var(--shadow-lg)',
                    maxHeight: 220,
                    overflowY: 'auto',
                  }}
                >
                  {models.length === 0 ? (
                    <div style={{ padding: '10px 12px', fontSize: 'var(--text-xs)', color: 'var(--color-text-tertiary)' }}>
                      该 provider 还没有模型。
                    </div>
                  ) : (
                    models.map((m, i) => (
                      <div
                        key={`${m.name}-${i}`}
                        onClick={() => selectModel(i)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '8px 12px',
                          cursor: 'pointer',
                          fontSize: 'var(--text-sm)',
                          background: i === selectedIndex ? 'var(--color-bg-tertiary)' : 'transparent',
                        }}
                      >
                        <span>{m.name}</span>
                        {confirmDeleteIndex === i ? (
                          <span style={{ display: 'inline-flex', gap: '6px' }} onClick={(e) => e.stopPropagation()}>
                            <button
                              type="button"
                              onClick={() => deleteModel(i)}
                              className="text-xs text-[var(--color-danger)]"
                            >
                              删除
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteIndex(null)}
                              className="text-xs text-[var(--color-text-secondary)]"
                            >
                              取消
                            </button>
                          </span>
                        ) : (
                          <button
                            type="button"
                            title="删除"
                            onClick={(e) => {
                              e.stopPropagation();
                              setConfirmDeleteIndex(i);
                            }}
                            className="text-[var(--color-text-tertiary)] hover:text-[var(--color-danger)]"
                          >
                            <X size={14} />
                          </button>
                        )}
                      </div>
                    ))
                  )}
                  <button
                    type="button"
                    onClick={() => selectModel(null)}
                    style={{
                      width: '100%',
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                      padding: '8px 12px',
                      fontSize: 'var(--text-sm)',
                      color: 'var(--color-brand)',
                      borderTop: '1px solid var(--color-separator)',
                      cursor: 'pointer',
                    }}
                  >
                    <Plus size={14} />
                    新增模型
                  </button>
                </div>
              )}
            </div>

            {adding && (
              <label style={labelStyle}>
                模型标识 (model name)
                <input
                  style={{ ...inputStyle, marginTop: '4px' }}
                  value={fields.name}
                  onChange={(e) => patchFields({ name: e.target.value })}
                  placeholder="claude-sonnet-5"
                />
              </label>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <label style={labelStyle}>
                温度
                <input
                  style={{ ...inputStyle, marginTop: '4px' }}
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={fields.temperature}
                  onChange={(e) => patchFields({ temperature: parseFloat(e.target.value) || 0 })}
                />
              </label>
              <label style={labelStyle}>
                最大 Tokens
                <input
                  style={{ ...inputStyle, marginTop: '4px' }}
                  type="number"
                  min={1}
                  max={32768}
                  step={1}
                  value={fields.maxTokens}
                  onChange={(e) => patchFields({ maxTokens: parseInt(e.target.value) || 32768 })}
                />
              </label>
              <label style={labelStyle}>
                Top P
                <input
                  style={{ ...inputStyle, marginTop: '4px' }}
                  type="number"
                  min={0}
                  max={1}
                  step={0.05}
                  value={fields.topP}
                  onChange={(e) => patchFields({ topP: parseFloat(e.target.value) || 1 })}
                />
              </label>
            </div>

            <label style={labelStyle}>
              最大上下文窗口 (tokens)
              <input
                style={{ ...inputStyle, marginTop: '4px' }}
                type="number"
                min={1}
                step={1000}
                value={fields.maxContext}
                onChange={(e) => patchFields({ maxContext: parseInt(e.target.value) || 1000000 })}
              />
            </label>

            <div style={{ marginTop: '12px', fontSize: 'var(--text-xs)', color: 'var(--color-text-secondary)', fontWeight: 600 }}>
              价格（$/Mtokens）
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <label style={labelStyle}>
                缓存
                <input
                  style={{ ...inputStyle, marginTop: '4px' }}
                  type="number"
                  min={0}
                  step={0.01}
                  value={fields.cachePrice}
                  onChange={(e) => patchFields({ cachePrice: parseFloat(e.target.value) || 0 })}
                />
              </label>
              <label style={labelStyle}>
                输入
                <input
                  style={{ ...inputStyle, marginTop: '4px' }}
                  type="number"
                  min={0}
                  step={0.01}
                  value={fields.inputPrice}
                  onChange={(e) => patchFields({ inputPrice: parseFloat(e.target.value) || 0 })}
                />
              </label>
              <label style={labelStyle}>
                输出
                <input
                  style={{ ...inputStyle, marginTop: '4px' }}
                  type="number"
                  min={0}
                  step={0.01}
                  value={fields.outputPrice}
                  onChange={(e) => patchFields({ outputPrice: parseFloat(e.target.value) || 0 })}
                />
              </label>
            </div>

            {adding && (
              <button
                type="button"
                onClick={addModel}
                disabled={!fields.name.trim()}
                style={{
                  marginTop: '16px',
                  width: '100%',
                  padding: '8px 16px',
                  borderRadius: 'var(--radius-md)',
                  background: 'var(--color-brand)',
                  color: '#fff',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 'var(--text-sm)',
                  fontWeight: 500,
                  opacity: fields.name.trim() ? 1 : 0.5,
                }}
              >
                添加模型
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

ProviderEditor.displayName = 'ProviderEditor';
