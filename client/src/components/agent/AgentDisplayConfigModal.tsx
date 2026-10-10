import React, { useState } from 'react';
import { X, Settings2, Pencil, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { AgentDisplayConfig } from '@obliview/shared';
import { prettifySensorLabel } from '../../utils/sensorLabels';
import { ToggleSwitch } from '../common/ToggleSwitch';

type Section = 'cpu' | 'ram' | 'gpu' | 'drives' | 'network' | 'temps';

interface Props {
  open: boolean;
  onClose: () => void;
  initialSection: Section;
  config: AgentDisplayConfig;
  onSave: (config: AgentDisplayConfig) => Promise<void>;
  onRenameSensor: (key: string, name: string) => Promise<void>;
  availableThreadCount: number;
  availableMounts: string[];
  availableInterfaces: string[];
  availableTemps: string[];
  availableGpuRows: string[];
  sensorDisplayNames: Record<string, string>;
}

/** [i18n key, English fallback] — CPU / RAM / GPU are kept as acronyms */
const TABS: Array<{ id: Section; label: [string, string] }> = [
  { id: 'cpu',     label: ['agentDisplay.tabCpu', 'CPU'] },
  { id: 'ram',     label: ['agentDisplay.tabRam', 'RAM'] },
  { id: 'gpu',     label: ['agentDisplay.tabGpu', 'GPU'] },
  { id: 'drives',  label: ['agentDisplay.tabDrives', 'Drives'] },
  { id: 'network', label: ['agentDisplay.tabNetwork', 'Network'] },
  { id: 'temps',   label: ['agentDisplay.tabTemps', 'Temperatures'] },
];

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">
      {children}
    </div>
  );
}

/** Toggle row — label left, switch right */
function ToggleRow({
  label, checked, onChange,
}: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between py-1.5 gap-3">
      <span className="text-sm text-text-secondary min-w-0 flex-1">{label}</span>
      <ToggleSwitch checked={checked} onChange={onChange} ariaLabel={label} />
    </div>
  );
}

// ── CPU Tab ───────────────────────────────────────────────────────────────────
function CpuTab({
  draft, onChange, availableThreadCount, availableTemps, sensorDisplayNames,
}: {
  draft: AgentDisplayConfig;
  onChange: (d: AgentDisplayConfig) => void;
  availableThreadCount: number;
  availableTemps: string[];
  sensorDisplayNames: Record<string, string>;
}) {
  const { t } = useTranslation();
  const physicalCores = Math.ceil(availableThreadCount / 2);
  const hiddenChartMap: Array<{ id: string; label: string }> = [
    { id: 'load-avg', label: t('agentDisplay.chartLoadAvg', 'Load Average') },
    { id: 'temp',     label: t('agentDisplay.chartTemperature', 'Temperature') },
    { id: 'freq',     label: t('agentDisplay.chartFrequency', 'Frequency') },
  ];

  const toggleCore = (coreIdx: number, visible: boolean) => {
    const next = visible
      ? draft.cpu.hiddenCores.filter(c => c !== coreIdx)
      : [...draft.cpu.hiddenCores, coreIdx];
    onChange({ ...draft, cpu: { ...draft.cpu, hiddenCores: next } });
  };
  const toggleHiddenChart = (chartId: string, visible: boolean) => {
    const next = visible
      ? draft.cpu.hiddenCharts.filter(c => c !== chartId)
      : [...draft.cpu.hiddenCharts, chartId];
    onChange({ ...draft, cpu: { ...draft.cpu, hiddenCharts: next } });
  };

  return (
    <div className="space-y-5">
      <ToggleRow
        label={t('agentDisplay.groupCoreThreads', 'Group Core / Threads')}
        checked={draft.cpu.groupCoreThreads}
        onChange={v => onChange({ ...draft, cpu: { ...draft.cpu, groupCoreThreads: v } })}
      />

      {physicalCores > 0 && (
        <div>
          <SectionHeader>{t('agentDisplay.cores', 'Cores')}</SectionHeader>
          <div className="space-y-0.5">
            {Array.from({ length: physicalCores }, (_, i) => {
              const visible = !draft.cpu.hiddenCores.includes(i);
              const label = draft.cpu.groupCoreThreads
                ? `C${i}`
                : `C${i} (T${i * 2 + 1} / T${i * 2 + 2})`;
              return (
                <ToggleRow key={i} label={label} checked={visible} onChange={v => toggleCore(i, v)} />
              );
            })}
          </div>
        </div>
      )}

      <div>
        <SectionHeader>{t('agentDisplay.tempSensor', 'Temperature Sensor')}</SectionHeader>
        <select
          value={draft.cpu.tempSensor ?? ''}
          onChange={e => onChange({ ...draft, cpu: { ...draft.cpu, tempSensor: e.target.value || null } })}
          className="w-full rounded border border-border bg-bg-tertiary text-sm text-text-primary px-3 py-1.5 focus:outline-none focus:ring-1 focus:ring-accent"
        >
          <option value="">{t('agentDisplay.average', '— Average —')}</option>
          {availableTemps.map(label => (
            <option key={label} value={label}>{sensorDisplayNames[`temp:${label}`] ?? prettifySensorLabel(label)}</option>
          ))}
        </select>
      </div>

      <div>
        <SectionHeader>{t('agentDisplay.charts', 'Charts')}</SectionHeader>
        <div className="space-y-0.5">
          {hiddenChartMap.map(({ id, label }) => (
            <ToggleRow
              key={id}
              label={label}
              checked={!draft.cpu.hiddenCharts.includes(id)}
              onChange={v => toggleHiddenChart(id, v)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── RAM Tab ───────────────────────────────────────────────────────────────────
function RamTab({ draft, onChange }: { draft: AgentDisplayConfig; onChange: (d: AgentDisplayConfig) => void }) {
  const { t } = useTranslation();
  const hiddenChartMap: Array<{ id: string; label: string }> = [
    { id: 'pct',     label: t('agentDisplay.chartUsagePct', 'Usage %') },
    { id: 'used-mb', label: t('agentDisplay.chartUsedMb', 'Used (MB)') },
    { id: 'swap',    label: t('agentDisplay.chartSwap', 'Swap') },
  ];
  const toggleHiddenChart = (chartId: string, visible: boolean) => {
    const next = visible
      ? draft.ram.hiddenCharts.filter(c => c !== chartId)
      : [...draft.ram.hiddenCharts, chartId];
    onChange({ ...draft, ram: { ...draft.ram, hiddenCharts: next } });
  };
  return (
    <div className="space-y-5">
      <div>
        <SectionHeader>{t('agentDisplay.rows', 'Rows')}</SectionHeader>
        <ToggleRow label={t('agentDisplay.showUsed', 'Show Used')}  checked={!draft.ram.hideUsed}  onChange={v => onChange({ ...draft, ram: { ...draft.ram, hideUsed:  !v } })} />
        <ToggleRow label={t('agentDisplay.showFree', 'Show Free')}  checked={!draft.ram.hideFree}  onChange={v => onChange({ ...draft, ram: { ...draft.ram, hideFree:  !v } })} />
        <ToggleRow label={t('agentDisplay.showSwap', 'Show Swap')}  checked={!draft.ram.hideSwap}  onChange={v => onChange({ ...draft, ram: { ...draft.ram, hideSwap:  !v } })} />
      </div>
      <div>
        <SectionHeader>{t('agentDisplay.charts', 'Charts')}</SectionHeader>
        <div className="space-y-0.5">
          {hiddenChartMap.map(({ id, label }) => (
            <ToggleRow key={id} label={label} checked={!draft.ram.hiddenCharts.includes(id)} onChange={v => toggleHiddenChart(id, v)} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── GPU Tab ───────────────────────────────────────────────────────────────────
function GpuTab({
  draft, onChange, availableGpuRows,
}: {
  draft: AgentDisplayConfig;
  onChange: (d: AgentDisplayConfig) => void;
  availableGpuRows: string[];
}) {
  const { t } = useTranslation();
  const hiddenChartMap: Array<{ id: string; label: string }> = [
    { id: 'util', label: t('agentDisplay.chartUtilization', 'Utilization') },
    { id: 'vram', label: t('agentDisplay.chartVram', 'VRAM') },
    { id: 'temp', label: t('agentDisplay.chartTemperature', 'Temperature') },
  ];
  const toggleRow = (rowLabel: string, visible: boolean) => {
    const next = visible
      ? draft.gpu.hiddenRows.filter(r => r !== rowLabel)
      : [...draft.gpu.hiddenRows, rowLabel];
    onChange({ ...draft, gpu: { ...draft.gpu, hiddenRows: next } });
  };
  const toggleHiddenChart = (chartId: string, visible: boolean) => {
    const next = visible
      ? draft.gpu.hiddenCharts.filter(c => c !== chartId)
      : [...draft.gpu.hiddenCharts, chartId];
    onChange({ ...draft, gpu: { ...draft.gpu, hiddenCharts: next } });
  };
  return (
    <div className="space-y-5">
      {availableGpuRows.length > 0 && (
        <div>
          <SectionHeader>{t('agentDisplay.rows', 'Rows')}</SectionHeader>
          <div className="space-y-0.5">
            {availableGpuRows.map(rowLabel => (
              <ToggleRow key={rowLabel} label={rowLabel} checked={!draft.gpu.hiddenRows.includes(rowLabel)} onChange={v => toggleRow(rowLabel, v)} />
            ))}
          </div>
        </div>
      )}
      <div>
        <SectionHeader>{t('agentDisplay.charts', 'Charts')}</SectionHeader>
        <div className="space-y-0.5">
          {hiddenChartMap.map(({ id, label }) => (
            <ToggleRow key={id} label={label} checked={!draft.gpu.hiddenCharts.includes(id)} onChange={v => toggleHiddenChart(id, v)} />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Drives Tab ────────────────────────────────────────────────────────────────
function DrivesTab({
  draft, onChange, availableMounts,
}: {
  draft: AgentDisplayConfig;
  onChange: (d: AgentDisplayConfig) => void;
  availableMounts: string[];
}) {
  const { t } = useTranslation();
  const [editingMount, setEditingMount] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const toggleMount = (mount: string, visible: boolean) => {
    const next = visible
      ? draft.drives.hiddenMounts.filter(m => m !== mount)
      : [...draft.drives.hiddenMounts, mount];
    onChange({ ...draft, drives: { ...draft.drives, hiddenMounts: next } });
  };
  const applyRename = (mount: string) => {
    const trimmed = renameValue.trim();
    const next = { ...draft.drives.renames };
    if (trimmed && trimmed !== mount) {
      next[mount] = trimmed;
    } else {
      delete next[mount];
    }
    onChange({ ...draft, drives: { ...draft.drives, renames: next } });
    setEditingMount(null);
  };

  return (
    <div className="space-y-5">
      <div>
        <SectionHeader>{t('agentDisplay.mountPoints', 'Mount Points')}</SectionHeader>
        <div className="space-y-1">
          {availableMounts.map(mount => {
            const visible = !draft.drives.hiddenMounts.includes(mount);
            const currentName = draft.drives.renames[mount] ?? mount;
            const isEditing = editingMount === mount;
            return (
              <div key={mount} className="flex items-center gap-2 py-1">
                {/* Visibility toggle */}
                <ToggleSwitch
                  checked={visible}
                  onChange={v => toggleMount(mount, v)}
                  ariaLabel={t('agentDisplay.showItem', { defaultValue: 'Show {{name}}', name: currentName })}
                />
                {isEditing ? (
                  <div className="flex items-center gap-1 flex-1 min-w-0">
                    <input
                      type="text"
                      value={renameValue}
                      autoFocus
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') applyRename(mount);
                        if (e.key === 'Escape') setEditingMount(null);
                      }}
                      className="flex-1 min-w-0 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <button onClick={() => applyRename(mount)} title={t('common.save', 'Save')} aria-label={t('common.save', 'Save')} className="p-0.5 rounded text-status-up hover:bg-bg-hover shrink-0"><Check size={11} /></button>
                    <button onClick={() => setEditingMount(null)} title={t('common.cancel', 'Cancel')} aria-label={t('common.cancel', 'Cancel')} className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover shrink-0"><X size={12} /></button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <span className="text-sm text-text-secondary truncate flex-1 min-w-0">{currentName}</span>
                    {currentName !== mount && (
                      <span className="text-[10px] text-text-muted truncate max-w-[80px]">({mount})</span>
                    )}
                    <button
                      onClick={() => { setEditingMount(mount); setRenameValue(currentName); }}
                      className="p-0.5 rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover shrink-0"
                      title={t('agentDisplay.rename', 'Rename')}
                      aria-label={t('agentDisplay.rename', 'Rename')}
                    >
                      <Pencil size={11} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <ToggleRow
        label={t('agentDisplay.combineReadWrite', 'Combine Read + Write on one chart')}
        checked={draft.drives.combineReadWrite}
        onChange={v => onChange({ ...draft, drives: { ...draft.drives, combineReadWrite: v } })}
      />
    </div>
  );
}

// ── Network Tab ───────────────────────────────────────────────────────────────
function NetworkTab({
  draft, onChange, availableInterfaces,
}: {
  draft: AgentDisplayConfig;
  onChange: (d: AgentDisplayConfig) => void;
  availableInterfaces: string[];
}) {
  const { t } = useTranslation();
  const [editingIface, setEditingIface] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  const toggleIface = (name: string, visible: boolean) => {
    const next = visible
      ? draft.network.hiddenInterfaces.filter(i => i !== name)
      : [...draft.network.hiddenInterfaces, name];
    onChange({ ...draft, network: { ...draft.network, hiddenInterfaces: next } });
  };
  const applyRename = (name: string) => {
    const trimmed = renameValue.trim();
    const next = { ...(draft.network.renames ?? {}) };
    if (trimmed && trimmed !== name) {
      next[name] = trimmed;
    } else {
      delete next[name];
    }
    onChange({ ...draft, network: { ...draft.network, renames: next } });
    setEditingIface(null);
  };

  return (
    <div className="space-y-5">
      <div>
        <SectionHeader>{t('agentDisplay.interfaces', 'Interfaces')}</SectionHeader>
        <div className="space-y-1">
          {availableInterfaces.map(name => {
            const visible = !draft.network.hiddenInterfaces.includes(name);
            const renames = draft.network.renames ?? {};
            const currentName = renames[name] ?? name;
            const isEditing = editingIface === name;
            return (
              <div key={name} className="flex items-center gap-2 py-1">
                {/* Visibility toggle */}
                <ToggleSwitch
                  checked={visible}
                  onChange={v => toggleIface(name, v)}
                  ariaLabel={t('agentDisplay.showItem', { defaultValue: 'Show {{name}}', name: currentName })}
                />
                {isEditing ? (
                  <div className="flex items-center gap-1 flex-1 min-w-0">
                    <input
                      type="text"
                      value={renameValue}
                      autoFocus
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') applyRename(name);
                        if (e.key === 'Escape') setEditingIface(null);
                      }}
                      className="flex-1 min-w-0 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <button onClick={() => applyRename(name)} title={t('common.save', 'Save')} aria-label={t('common.save', 'Save')} className="p-0.5 rounded text-status-up hover:bg-bg-hover shrink-0"><Check size={11} /></button>
                    <button onClick={() => setEditingIface(null)} title={t('common.cancel', 'Cancel')} aria-label={t('common.cancel', 'Cancel')} className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover shrink-0"><X size={12} /></button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <span className="text-sm text-text-secondary truncate flex-1 min-w-0">{currentName}</span>
                    {currentName !== name && (
                      <span className="text-[10px] text-text-muted truncate max-w-[80px]">({name})</span>
                    )}
                    <button
                      onClick={() => { setEditingIface(name); setRenameValue(currentName); }}
                      className="p-0.5 rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover shrink-0"
                      title={t('agentDisplay.rename', 'Rename')}
                      aria-label={t('agentDisplay.rename', 'Rename')}
                    >
                      <Pencil size={11} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <ToggleRow
        label={t('agentDisplay.combineInOut', 'Combine IN + OUT on one chart')}
        checked={draft.network.combineInOut}
        onChange={v => onChange({ ...draft, network: { ...draft.network, combineInOut: v } })}
      />
    </div>
  );
}

// ── Temps Tab ─────────────────────────────────────────────────────────────────
function TempsTab({
  draft, onChange, availableTemps, sensorDisplayNames, onRenameSensor,
}: {
  draft: AgentDisplayConfig;
  onChange: (d: AgentDisplayConfig) => void;
  availableTemps: string[];
  sensorDisplayNames: Record<string, string>;
  onRenameSensor: (key: string, name: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editingSensor, setEditingSensor] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [saving, setSaving] = useState(false);

  const toggleTemp = (label: string, visible: boolean) => {
    const next = visible
      ? draft.temps.hiddenLabels.filter(l => l !== label)
      : [...draft.temps.hiddenLabels, label];
    onChange({ ...draft, temps: { ...draft.temps, hiddenLabels: next } });
  };

  const applySensorRename = async (label: string) => {
    const key = `temp:${label}`;
    setSaving(true);
    try {
      await onRenameSensor(key, renameValue.trim());
      setEditingSensor(null);
    } catch { /* ignore */ }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-5">
      <div>
        <SectionHeader>{t('agentDisplay.sensors', 'Sensors')}</SectionHeader>
        <div className="space-y-1">
          {availableTemps.map(label => {
            const key = `temp:${label}`;
            const displayName = sensorDisplayNames[key] ?? prettifySensorLabel(label);
            const visible = !draft.temps.hiddenLabels.includes(label);
            const isEditing = editingSensor === key;
            return (
              <div key={label} className="flex items-center gap-2 py-1">
                {/* Visibility toggle */}
                <ToggleSwitch
                  checked={visible}
                  onChange={v => toggleTemp(label, v)}
                  ariaLabel={t('agentDisplay.showItem', { defaultValue: 'Show {{name}}', name: displayName })}
                />
                {isEditing ? (
                  <div className="flex items-center gap-1 flex-1 min-w-0">
                    <input
                      type="text"
                      value={renameValue}
                      autoFocus
                      onChange={e => setRenameValue(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter') void applySensorRename(label);
                        if (e.key === 'Escape') setEditingSensor(null);
                      }}
                      className="flex-1 min-w-0 rounded border border-border bg-bg-tertiary px-2 py-0.5 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
                    />
                    <button onClick={() => void applySensorRename(label)} disabled={saving} title={t('common.save', 'Save')} aria-label={t('common.save', 'Save')} className="p-0.5 rounded text-status-up hover:bg-bg-hover shrink-0 disabled:opacity-50"><Check size={11} /></button>
                    <button onClick={() => setEditingSensor(null)} title={t('common.cancel', 'Cancel')} aria-label={t('common.cancel', 'Cancel')} className="p-0.5 rounded text-text-muted hover:text-text-primary hover:bg-bg-hover shrink-0"><X size={12} /></button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1.5 flex-1 min-w-0">
                    <span className="text-sm text-text-secondary truncate flex-1 min-w-0">{displayName}</span>
                    {displayName !== label && (
                      <span className="text-[10px] text-text-muted truncate max-w-[80px]">({label})</span>
                    )}
                    <button
                      onClick={() => { setEditingSensor(key); setRenameValue(displayName); }}
                      className="p-0.5 rounded text-text-muted hover:text-text-secondary hover:bg-bg-hover shrink-0"
                      title={t('agentDisplay.renameSensor', 'Rename sensor')}
                      aria-label={t('agentDisplay.renameSensor', 'Rename sensor')}
                    >
                      <Pencil size={11} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ── Modal ─────────────────────────────────────────────────────────────────────
export function AgentDisplayConfigModal({
  open, onClose, initialSection, config, onSave, onRenameSensor,
  availableThreadCount, availableMounts, availableInterfaces,
  availableTemps, availableGpuRows, sensorDisplayNames,
}: Props) {
  const { t } = useTranslation();
  const [activeSection, setActiveSection] = useState<Section>(initialSection);
  const [draft, setDraft] = useState<AgentDisplayConfig>(config);
  const [saving, setSaving] = useState(false);

  // Reset draft + section whenever the modal opens
  React.useEffect(() => {
    if (open) {
      setDraft(config);
      setActiveSection(initialSection);
    }
  }, [open, initialSection]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null;

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(draft);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
      <div className="w-full max-w-2xl rounded-xl border border-border bg-bg-primary shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-base font-semibold text-text-primary flex items-center gap-2">
            <Settings2 size={16} /> {t('agentDisplay.title', 'Display Configuration')}
          </h2>
          <button onClick={onClose} title={t('common.close', 'Close')} aria-label={t('common.close', 'Close')} className="text-text-muted hover:text-text-primary text-xl leading-none">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden min-h-0">
          {/* Left sidebar */}
          <div className="w-36 shrink-0 border-r border-border py-3 flex flex-col gap-0.5 px-2 overflow-y-auto">
            {TABS.map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveSection(tab.id)}
                className={[
                  'w-full text-left px-3 py-2 rounded-lg text-sm transition-colors',
                  activeSection === tab.id
                    ? 'bg-bg-hover text-text-primary'
                    : 'text-text-muted hover:text-text-secondary hover:bg-bg-hover/50',
                ].join(' ')}
              >
                {t(tab.label[0], tab.label[1])}
              </button>
            ))}
          </div>

          {/* Right content */}
          <div className="flex-1 overflow-y-auto p-5 space-y-5">
            {activeSection === 'cpu' && (
              <CpuTab
                draft={draft}
                onChange={setDraft}
                availableThreadCount={availableThreadCount}
                availableTemps={availableTemps}
                sensorDisplayNames={sensorDisplayNames}
              />
            )}
            {activeSection === 'ram' && (
              <RamTab draft={draft} onChange={setDraft} />
            )}
            {activeSection === 'gpu' && (
              <GpuTab draft={draft} onChange={setDraft} availableGpuRows={availableGpuRows} />
            )}
            {activeSection === 'drives' && (
              <DrivesTab draft={draft} onChange={setDraft} availableMounts={availableMounts} />
            )}
            {activeSection === 'network' && (
              <NetworkTab draft={draft} onChange={setDraft} availableInterfaces={availableInterfaces} />
            )}
            {activeSection === 'temps' && (
              <TempsTab
                draft={draft}
                onChange={setDraft}
                availableTemps={availableTemps}
                sensorDisplayNames={sensorDisplayNames}
                onRenameSensor={onRenameSensor}
              />
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 px-6 py-4 border-t border-border shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg border border-border text-sm text-text-secondary hover:bg-bg-hover transition-colors"
          >
            {t('common.cancel', 'Cancel')}
          </button>
          <button
            onClick={() => void handleSave()}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-accent text-white text-sm font-medium hover:bg-accent/90 transition-colors disabled:opacity-50"
          >
            {saving ? t('common.saving', 'Saving…') : t('common.apply', 'Apply')}
          </button>
        </div>
      </div>
    </div>
  );
}

export default AgentDisplayConfigModal;
