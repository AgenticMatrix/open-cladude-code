import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Cpu, ChevronDown, Check } from 'lucide-react';
import { useSettingsStore } from '../../store/settingsStore.js';
import { setSessionModel } from '../../ipc-client.js';
import './ModelCascadePicker.css';

export interface ModelCascadePickerProps {
  /** Current model, "provider/model" or a bare model name. */
  model?: string;
}

/**
 * Two-step model picker for the composer: click → provider list → click a
 * provider → that provider's model list. Selecting a model binds it to the
 * active session (per-session model switch) and refreshes the settings store.
 *
 * Mirrors the agentstation-app cascade picker (ModelButton / ModelCascadePicker),
 * adapted to read providers/models from the settings store instead of a model
 * registry.
 */
export function ModelCascadePicker({ model = '' }: ModelCascadePickerProps): React.ReactElement {
  const providers = useSettingsStore((s) => s.settings?.providers ?? []);
  const [open, setOpen] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);

  // Current provider slug, if the model is already in "provider/model" form.
  const currentProvider = useMemo(() => {
    const idx = model.indexOf('/');
    return idx > 0 ? model.slice(0, idx).toLowerCase() : null;
  }, [model]);

  const providerModels = useMemo(() => {
    if (!selectedProvider) return [];
    const p = providers.find((pr) => pr.name.toLowerCase() === selectedProvider);
    return p?.models ?? [];
  }, [providers, selectedProvider]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popupRef.current && !popupRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const toggleOpen = () => {
    if (!open) {
      const slugs = providers.map((p) => p.name.toLowerCase());
      setSelectedProvider(currentProvider && slugs.includes(currentProvider) ? currentProvider : (slugs[0] ?? null));
    }
    setOpen((prev) => !prev);
  };

  const handleSelect = (providerName: string, modelName: string) => {
    setOpen(false);
    setSessionModel(`${providerName}/${modelName}`)
      .then(() => useSettingsStore.getState().load())
      .catch(() => {});
  };

  return (
    <div className="model-cascade-wrap" ref={popupRef}>
      <button
        type="button"
        className="model-picker-btn"
        onClick={toggleOpen}
        title="切换模型"
      >
        <Cpu size={13} />
        <span className="model-cascade-label">{model || '未配置模型'}</span>
        <ChevronDown size={10} />
      </button>

      {open && (
        <div className="model-cascade-popup">
          <div className="model-cascade-header">切换模型</div>
          <div className="model-cascade-body">
            <div className="model-cascade-providers">
              {providers.map((p) => (
                <button
                  key={p.name}
                  type="button"
                  className={`model-cascade-provider${selectedProvider === p.name.toLowerCase() ? ' active' : ''}`}
                  onClick={() => setSelectedProvider(p.name.toLowerCase())}
                >
                  <span className="model-cascade-provider-label">{p.name}</span>
                </button>
              ))}
            </div>
            <div className="model-cascade-models">
              {providerModels.length === 0 ? (
                <div className="model-cascade-empty">该 provider 暂无模型</div>
              ) : (
                providerModels.map((m) => {
                  const active = selectedProvider
                    ? model.toLowerCase() === `${selectedProvider}/${m.name}`.toLowerCase()
                    : false;
                  return (
                    <button
                      key={m.name}
                      type="button"
                      className={`model-cascade-model${active ? ' active' : ''}`}
                      onClick={() => selectedProvider && handleSelect(selectedProvider, m.name)}
                    >
                      <span className="model-cascade-model-name">{m.name}</span>
                      {active && <Check size={14} className="model-cascade-check" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

ModelCascadePicker.displayName = 'ModelCascadePicker';
