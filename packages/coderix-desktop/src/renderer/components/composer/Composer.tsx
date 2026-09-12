import React, { useState, useRef, useCallback, useEffect, type KeyboardEvent } from 'react';
import { ArrowUp, Square } from 'lucide-react';
import './Composer.css';

export interface ComposerProps {
  value?: string;
  onChange?: (value: string) => void;
  onSubmit?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  isStreaming?: boolean;
  onInterrupt?: () => void;
}

// ── Slash commands ─────────────────────────────────

const SLASH_COMMANDS = [
  { cmd: '/explain', label: 'Explain code', desc: '解释选中的代码', prompt: '请解释以下代码：\n\n' },
  { cmd: '/fix', label: 'Fix bug', desc: '修复代码中的 bug', prompt: '请修复以下代码中的问题：\n\n' },
  { cmd: '/refactor', label: 'Refactor', desc: '重构优化代码', prompt: '请重构以下代码，提高可读性和性能：\n\n' },
  { cmd: '/test', label: 'Write tests', desc: '为代码编写测试', prompt: '请为以下代码编写单元测试：\n\n' },
  { cmd: '/review', label: 'Code review', desc: '代码审查', prompt: '请对以下代码进行审查：\n\n' },
  { cmd: '/optimize', label: 'Optimize', desc: '性能优化', prompt: '请优化以下代码的性能：\n\n' },
  { cmd: '/doc', label: 'Add docs', desc: '添加文档注释', prompt: '请为以下代码添加文档注释：\n\n' },
];

export function Composer({
  value: controlledValue,
  onChange,
  onSubmit,
  disabled = false,
  placeholder = 'Ask Coderix anything...',
  isStreaming = false,
  onInterrupt,
}: ComposerProps): React.ReactElement {
  const [internalValue, setInternalValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [showAtMenu, setShowAtMenu] = useState(false);
  const [atFiles, setAtFiles] = useState<string[]>([]);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const currentValue = controlledValue ?? internalValue;
  const canSend = currentValue.trim().length > 0 && !disabled;

  // Detect / or @ trigger
  const detectTrigger = useCallback((val: string) => {
    const cursorPos = textareaRef.current?.selectionStart ?? val.length;
    const textBeforeCursor = val.slice(0, cursorPos);

    // Slash command: / at start or after space
    const slashMatch = textBeforeCursor.match(/(?:^|\s)\/(\w*)$/);
    if (slashMatch) {
      setShowSlashMenu(true);
      setShowAtMenu(false);
      setSelectedIdx(0);
      return;
    }
    setShowSlashMenu(false);

    // @-mention: @ at start or after space
    const atMatch = textBeforeCursor.match(/(?:^|\s)@(\S*)$/);
    if (atMatch) {
      setShowAtMenu(true);
      setShowSlashMenu(false);
      setSelectedIdx(0);
      loadAtFiles(atMatch[1]);
      return;
    }
    setShowAtMenu(false);
  }, []);

  // Run trigger detection on value change
  useEffect(() => { detectTrigger(currentValue); }, [currentValue, detectTrigger]);

  const loadAtFiles = async (query: string) => {
    const api = window.coderixAPI?.fs;
    if (!api) return;
    try {
      const result = await api.listDir('');
      if (result?.entries) {
        const names = result.entries
          .filter((e: any) => !e.name.startsWith('.') || e.name === '.gitignore')
          .map((e: any) => e.name + (e.isDirectory ? '/' : ''))
          .filter((n: string) => n.toLowerCase().includes(query.toLowerCase()));
        setAtFiles(names.slice(0, 10));
      }
    } catch { setAtFiles([]); }
  };

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newValue = e.target.value;
      setInternalValue(newValue);
      onChange?.(newValue);
      // Trigger detection synchronously for responsiveness
      const cursorPos = e.target.selectionStart;
      const textBeforeCursor = newValue.slice(0, cursorPos);
      const slashMatch = textBeforeCursor.match(/(?:^|\s)\/(\w*)$/);
      if (slashMatch) {
        setShowSlashMenu(true); setShowAtMenu(false); setSelectedIdx(0);
      } else {
        setShowSlashMenu(false);
        const atMatch = textBeforeCursor.match(/(?:^|\s)@(\S*)$/);
        if (atMatch) {
          setShowAtMenu(true); setShowSlashMenu(false); setSelectedIdx(0);
          loadAtFiles(atMatch[1]);
        } else {
          setShowAtMenu(false);
        }
      }
    },
    [onChange],
  );

  const applySlash = (cmd: typeof SLASH_COMMANDS[0]) => {
    const newVal = currentValue.replace(/\/(\w*)$/, cmd.prompt);
    setInternalValue(newVal);
    onChange?.(newVal);
    setShowSlashMenu(false);
    textareaRef.current?.focus();
  };

  const applyAt = (fileName: string) => {
    const newVal = currentValue.replace(/@(\S*)$/, `@${fileName} `);
    setInternalValue(newVal);
    onChange?.(newVal);
    setShowAtMenu(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Slash menu navigation
      if (showSlashMenu) {
        const items = SLASH_COMMANDS.filter(c => {
          const m = currentValue.match(/\/(\w*)$/);
          return !m || c.cmd.includes(m[1] || '');
        });
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((s) => Math.min(s + 1, items.length - 1)); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((s) => Math.max(s - 1, 0)); return; }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          if (items[selectedIdx]) applySlash(items[selectedIdx]);
          return;
        }
        if (e.key === 'Escape') { setShowSlashMenu(false); return; }
      }

      // @ menu navigation
      if (showAtMenu) {
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIdx((s) => Math.min(s + 1, atFiles.length - 1)); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIdx((s) => Math.max(s - 1, 0)); return; }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          if (atFiles[selectedIdx]) applyAt(atFiles[selectedIdx]);
          return;
        }
        if (e.key === 'Escape') { setShowAtMenu(false); return; }
      }

      // Send on Enter (no Shift, no Cmd)
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        if (canSend) { onSubmit?.(currentValue.trim()); setInternalValue(''); onChange?.(''); }
      }
      if (e.key === 'Enter' && e.metaKey) {
        e.preventDefault();
        if (canSend) { onSubmit?.(currentValue.trim()); setInternalValue(''); onChange?.(''); }
      }
    },
    [canSend, currentValue, onSubmit, onChange, showSlashMenu, showAtMenu, atFiles, selectedIdx],
  );

  const filteredCommands = SLASH_COMMANDS.filter(c => {
    const m = currentValue.match(/\/(\w*)$/);
    return !m || c.cmd.includes(m[1] || '');
  });

  return (
    <div className="composer" style={{ position: 'relative' }}>
      {/* Slash command menu */}
      {showSlashMenu && (
        <div className="composer-dropdown" style={{ bottom: '100%', left: 0, marginBottom: '4px' }}>
          {filteredCommands.map((c, i) => (
            <div key={c.cmd} className={`composer-dropdown-item ${i === selectedIdx ? 'active' : ''}`}
              onClick={() => applySlash(c)} onMouseEnter={() => setSelectedIdx(i)}>
              <span className="font-mono font-bold text-[var(--color-brand)]">{c.cmd}</span>
              <div><div className="text-sm">{c.label}</div><div className="text-[10px] text-[var(--color-text-tertiary)]">{c.desc}</div></div>
            </div>
          ))}
        </div>
      )}

      {/* @-mention menu */}
      {showAtMenu && (
        <div className="composer-dropdown" style={{ bottom: '100%', left: 0, marginBottom: '4px' }}>
          {atFiles.length === 0 ? (
            <div className="p-3 text-xs text-[var(--color-text-tertiary)]">No files found</div>
          ) : (
            atFiles.map((f, i) => (
              <div key={f} className={`composer-dropdown-item ${i === selectedIdx ? 'active' : ''}`}
                onClick={() => applyAt(f)} onMouseEnter={() => setSelectedIdx(i)}>
                <span className="text-sm">{f}</span>
              </div>
            ))
          )}
        </div>
      )}

      {/* Input */}
      <div className="composer-input-wrapper">
        <textarea
          ref={textareaRef}
          className="composer-input"
          placeholder={placeholder}
          value={currentValue}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          rows={1}
          aria-label="Message input"
        />
        <div className="composer-input-actions">
          {isStreaming ? (
            <button className="composer-input-btn stop" onClick={onInterrupt} title="Stop (⌘.)" type="button" aria-label="Stop">
              <Square size={14} />
            </button>
          ) : (
            <button className="composer-input-btn send" onClick={() => {
              if (canSend) { onSubmit?.(currentValue.trim()); setInternalValue(''); onChange?.(''); }
            }} disabled={!canSend} title="Send (⌘⏎)" type="button" aria-label="Send">
              <ArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

Composer.displayName = 'Composer';
