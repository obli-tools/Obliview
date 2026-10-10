import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Download, FileText, Filter, RefreshCw, Search, Trash2 } from 'lucide-react';
import { clsx } from 'clsx';
import toast from 'react-hot-toast';
import { useTranslation } from 'react-i18next';
import type { User } from '@obliview/shared';
import { auditApi, type AuditLogFilters, type AuditLogRow } from '@/api/audit.api';
import { usersApi } from '@/api/users.api';
import { useAuthStore } from '@/store/authStore';
import { useIsGodView } from '@/hooks/useIsGodView';
import { MEDIA, useIsCoarsePointer, useMediaQuery } from '@/hooks/useMediaQuery';
import { useClickOutside } from '@/hooks/useClickOutside';
import { PageContainer } from '@/components/common/PageContainer';
import { TableScroll } from '@/components/common/TableScroll';
import { IconButton } from '@/components/common/IconButton';
import { TenantBadge } from '@/components/common/TenantBadge';
import { TenantFilterChips } from '@/components/common/TenantFilterChips';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { saveBlob } from '@/utils/download';
import { apiErrorMessage } from '@/utils/apiError';

// Audit log — "who did what, when, and from where" (Obliance port).
// Readable with the 'supervision:read' capability (route guard + server);
// clearing it is reserved to platform admins. The god view (platform admin
// on the master tenant) sees every tenant, with a tenant column and chips.

const PAGE_SIZE = 50;

function actionPill(action: string) {
  const isDestructive = /delete|refuse|removed|cleared|denied/.test(action);
  const isSecurity = /^auth\.|^obligate\.|^config\.|permission|role|2fa/.test(action);
  const color = isDestructive
    ? 'bg-red-400/10 text-red-400 border-red-400/30'
    : isSecurity
      ? 'bg-accent/10 text-accent border-accent/30'
      : 'bg-bg-tertiary text-text-secondary border-transparent';
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium border ${color} whitespace-nowrap`}>
      {action}
    </span>
  );
}

function resourceLabel(row: AuditLogRow): string {
  if (!row.resourceType) return '';
  const ref = row.resourceId ?? row.resourcePath ?? '';
  return ref ? `${row.resourceType}#${ref}` : row.resourceType;
}

function Row({ row, showTenant }: { row: AuditLogRow; showTenant: boolean }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const hasDetails = !!row.details && Object.keys(row.details).length > 0;
  const colSpan = showTenant ? 6 : 5;
  const ref = resourceLabel(row);

  return (
    <>
      <tr
        className={clsx('hover:bg-bg-tertiary/30', hasDetails && 'cursor-pointer')}
        onClick={() => hasDetails && setOpen((v) => !v)}
      >
        <td className="px-2 py-1.5 text-[11px] text-text-muted whitespace-nowrap">
          <div className="flex items-center gap-1">
            {hasDetails
              ? (open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)
              : <span className="w-3" />}
            {new Date(row.createdAt).toLocaleString()}
          </div>
        </td>
        {showTenant && (
          <td className="px-2 py-1.5">
            {row.tenantId != null ? (
              <TenantBadge tenantId={row.tenantId} tenantName={row.tenantName} />
            ) : (
              <span className="text-[10px] text-text-muted italic">{t('audit.platform', 'Platform')}</span>
            )}
          </td>
        )}
        <td className="px-2 py-1.5">{actionPill(row.action)}</td>
        <td className="px-2 py-1.5 text-xs text-text-primary">
          {row.username ? (
            <span>{row.username}</span>
          ) : (
            <span className="text-text-muted italic">{t('audit.system', 'system')}</span>
          )}
        </td>
        <td
          className="px-2 py-1.5 text-[11px] max-w-[280px] lg:truncate max-lg:min-w-[180px] max-lg:break-all"
          title={ref}
        >
          {row.resourceType ? (
            <span className="inline-flex items-baseline gap-1 max-lg:flex-wrap">
              {row.resourceName ? (
                <>
                  <span className="text-text-primary">{row.resourceName}</span>
                  <span className="text-[10px] text-text-muted font-mono">{ref}</span>
                </>
              ) : (
                <span className="text-text-muted font-mono">{ref}</span>
              )}
            </span>
          ) : (
            <span className="text-text-muted">—</span>
          )}
        </td>
        <td className="px-2 py-1.5 text-[11px] text-text-muted font-mono">{row.ipAddress || '—'}</td>
      </tr>
      {open && hasDetails && (
        <tr className="bg-bg-primary/50">
          <td colSpan={colSpan} className="px-8 py-2 [--table-sticky-bg:transparent]">
            <pre className="text-[11px] text-text-secondary font-mono whitespace-pre-wrap break-all max-h-64 overflow-auto">
              {JSON.stringify(row.details, null, 2)}
            </pre>
          </td>
        </tr>
      )}
    </>
  );
}

/** ISO string → value of a datetime-local input (local time). */
function toLocalInput(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function csvCell(value: unknown): string {
  let s = String(value ?? '');
  // Neutralise spreadsheet formulas (CSV injection).
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function AuditLogPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const isWide = useMediaQuery(MEDIA.lg);
  const isGodView = useIsGodView();
  const isPlatformAdmin = useAuthStore((s) => s.user?.role === 'admin');

  // God view: single-select tenant chip (one customer at a time).
  const [tenantFilter, setTenantFilter] = useState<Set<number>>(new Set());
  const filterTenantId = isGodView && tenantFilter.size === 1 ? [...tenantFilter][0] : undefined;

  const [items, setItems] = useState<AuditLogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [filters, setFilters] = useState<AuditLogFilters>({ limit: PAGE_SIZE, offset: 0 });
  const [actions, setActions] = useState<string[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [search, setSearch] = useState('');
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async (spinner = true) => {
    if (spinner) setIsLoading(true);
    try {
      const res = await auditApi.list({ ...filters, filterTenantId });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('audit.loadFailed', 'Failed to load the audit log')));
    } finally {
      if (spinner) setIsLoading(false);
    }
  }, [filters, filterTenantId, t]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    auditApi.distinctActions(filterTenantId).then(setActions).catch(() => {});
  }, [filterTenantId]);

  useEffect(() => {
    // The user list needs 'users.manage': without it the filter simply has no choices.
    usersApi.list().then(setUsers).catch(() => setUsers([]));
  }, []);

  const applySearch = () => setFilters((f) => ({ ...f, search: search.trim() || undefined, offset: 0 }));
  const clearFilters = () => {
    setSearch('');
    setFilters({ limit: PAGE_SIZE, offset: 0 });
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      // Every row matching the filters (not just the visible page), up to 5000.
      const all: AuditLogRow[] = [];
      const pageSize = 500;
      for (let offset = 0; offset < Math.min(total || pageSize, 5000); offset += pageSize) {
        const res = await auditApi.list({ ...filters, filterTenantId, limit: pageSize, offset });
        all.push(...res.items);
        if (res.items.length < pageSize) break;
      }
      const header = ['When', 'Tenant', 'Action', 'User', 'Resource', 'Resource name', 'IP', 'Details'];
      const rows = all.map((r) => [
        new Date(r.createdAt).toISOString(),
        r.tenantName ?? (r.tenantId != null ? `#${r.tenantId}` : 'platform'),
        r.action,
        r.username ?? '',
        resourceLabel(r),
        r.resourceName ?? '',
        r.ipAddress ?? '',
        r.details ? JSON.stringify(r.details) : '',
      ]);
      const csv = [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n');
      const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
      const ok = await saveBlob(blob, `audit-log-${new Date().toISOString().slice(0, 10)}.csv`, 'text/csv');
      if (!ok) toast.error(t('common.error'));
    } catch (err) {
      toast.error(apiErrorMessage(err, t('audit.exportFailed', 'Export failed')));
    } finally {
      setExporting(false);
    }
  };

  const clearLog = async () => {
    const ok = await confirm({
      title: t('audit.clearTitle', 'Clear the audit log'),
      message: t(
        'audit.clearConfirm',
        'Delete every audit entry of this workspace? A single "audit.cleared" entry is kept so the wipe itself stays traceable.',
      ),
      danger: true,
      confirmLabel: t('audit.clearAction', 'Clear'),
    });
    if (!ok) return;
    try {
      const r = await auditApi.clear();
      toast.success(t('audit.cleared', '{{count}} entries deleted', { count: r.deleted }));
      void load(true);
    } catch (err) {
      toast.error(apiErrorMessage(err, t('audit.clearFailed', 'Could not clear the audit log')));
    }
  };

  const limit = filters.limit ?? PAGE_SIZE;
  const page = Math.floor((filters.offset ?? 0) / limit) + 1;
  const pages = Math.max(1, Math.ceil(total / limit));

  // Distinct actions grouped by their root ('team', 'auth'…) for the dropdown.
  const groupedActions = useMemo(() => {
    const groups: Record<string, string[]> = {};
    for (const a of actions) {
      const root = a.split('.')[0];
      (groups[root] ??= []).push(a);
    }
    return groups;
  }, [actions]);

  const inputCls = 'py-1.5 coarse:py-2 px-2 text-xs bg-bg-secondary rounded text-text-primary max-w-full';
  const labelCls = 'block text-[10px] uppercase text-text-muted mb-0.5';

  return (
    <PageContainer embedded={embedded}>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        {!embedded ? (
          <div className="flex items-center gap-3">
            <FileText className="w-6 h-6 text-accent" />
            <div>
              <h1 className="text-xl font-semibold text-text-primary">{t('audit.title', 'Audit log')}</h1>
              <p className="text-sm text-text-muted">{t('audit.subtitle', 'Who did what, when, and from where.')}</p>
            </div>
          </div>
        ) : <div />}
        <div className="flex items-center gap-2 coarse:gap-3">
          <button
            type="button"
            onClick={exportCsv}
            disabled={items.length === 0 || exporting}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 coarse:px-3 coarse:py-2 rounded text-text-muted hover:text-text-primary transition-colors disabled:opacity-50"
          >
            <Download className="w-3.5 h-3.5" /> {t('audit.exportCsv', 'CSV')}
          </button>
          {isPlatformAdmin && (
            <button
              type="button"
              onClick={clearLog}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 coarse:px-3 coarse:py-2 rounded border border-red-400/30 text-red-400 hover:bg-red-400/10 transition-colors"
              title={t('audit.clearHint', 'Delete every audit entry of this workspace')}
            >
              <Trash2 className="w-3.5 h-3.5" /> {t('audit.clearAction', 'Clear')}
            </button>
          )}
          <IconButton
            label={t('common.refresh')}
            icon={<RefreshCw className="w-4 h-4" />}
            variant="plain"
            onClick={() => void load(true)}
          />
        </div>
      </div>

      {/* God view: tenant chips (single-select). Renders nothing elsewhere. */}
      <TenantFilterChips
        className="mb-3"
        value={tenantFilter}
        onChange={(next) => {
          if (next.size <= 1) { setTenantFilter(next); return; }
          const added = [...next].find((id) => !tenantFilter.has(id));
          setTenantFilter(added !== undefined ? new Set([added]) : new Set());
        }}
      />

      {/* Filters */}
      <div className="flex items-end gap-2 mb-4 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <label className={labelCls}>{t('common.search')}</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && applySearch()}
              placeholder={t('audit.searchPlaceholder', 'action, resource, details, username…')}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              enterKeyHint="search"
              className="w-full pl-7 pr-2 py-1.5 coarse:py-2 text-xs bg-bg-secondary rounded text-text-primary"
            />
          </div>
        </div>
        <div>
          <label className={labelCls}>{t('audit.colAction', 'Action')}</label>
          <select
            value={filters.action || ''}
            onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value || undefined, offset: 0 }))}
            className={clsx(inputCls, 'min-w-[180px]')}
          >
            <option value="">{t('common.all')}</option>
            {Object.entries(groupedActions).map(([root, acts]) => (
              <optgroup key={root} label={root}>
                <option value={`${root}.`}>{t('audit.allOfCategory', 'All {{root}}.*', { root })}</option>
                {acts.map((a) => <option key={a} value={a}>{a}</option>)}
              </optgroup>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>{t('audit.colUser', 'User')}</label>
          <UserCombobox
            users={users}
            value={filters.userId ?? null}
            onChange={(id) => setFilters((f) => ({ ...f, userId: id ?? undefined, offset: 0 }))}
          />
        </div>
        <div>
          <label className={labelCls}>{t('audit.since', 'Since')}</label>
          <input
            type="datetime-local"
            value={toLocalInput(filters.since)}
            onChange={(e) => setFilters((f) => ({ ...f, since: e.target.value ? new Date(e.target.value).toISOString() : undefined, offset: 0 }))}
            className={inputCls}
          />
        </div>
        <div>
          <label className={labelCls}>{t('audit.until', 'Until')}</label>
          <input
            type="datetime-local"
            value={toLocalInput(filters.until)}
            onChange={(e) => setFilters((f) => ({ ...f, until: e.target.value ? new Date(e.target.value).toISOString() : undefined, offset: 0 }))}
            className={inputCls}
          />
        </div>
        <button
          type="button"
          onClick={applySearch}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 coarse:py-2.5 rounded border border-accent/40 bg-accent/10 text-accent hover:bg-accent/20"
        >
          <Filter className="w-3.5 h-3.5" /> {t('common.apply')}
        </button>
        <button
          type="button"
          onClick={clearFilters}
          className="text-xs px-2 py-1.5 coarse:px-3 coarse:py-2.5 rounded text-text-muted hover:text-text-primary"
        >
          {t('common.reset')}
        </button>
      </div>

      <TableScroll className="rounded bg-bg-secondary" stickyFirstCol={!isWide}>
        {isLoading ? (
          <div className="p-8 text-center text-text-muted text-sm italic">{t('common.loading')}</div>
        ) : items.length === 0 ? (
          <div className="p-8 text-center text-text-muted text-sm italic">{t('audit.empty', 'No audit entries match your filters.')}</div>
        ) : (
          <table className="w-full border-collapse min-w-[640px]">
            <thead>
              <tr className="bg-bg-primary/40">
                {[
                  t('audit.colWhen', 'When'),
                  ...(isGodView ? [t('audit.colTenant', 'Tenant')] : []),
                  t('audit.colAction', 'Action'),
                  t('audit.colUser', 'User'),
                  t('audit.colResource', 'Resource'),
                  t('audit.colIp', 'IP'),
                ].map((label, i) => (
                  <Fragment key={i}>
                    <th className="px-2 py-1.5 text-left text-[10px] uppercase text-text-muted font-medium">{label}</th>
                  </Fragment>
                ))}
              </tr>
            </thead>
            <tbody>
              {items.map((row) => <Row key={row.id} row={row} showTenant={isGodView} />)}
            </tbody>
          </table>
        )}
      </TableScroll>

      {total > limit && (
        <div className="flex flex-wrap items-center justify-between gap-2 mt-3 text-xs text-text-muted">
          <span>{t('audit.pagination', '{{total}} entries · page {{page}} of {{pages}}', { total, page, pages })}</span>
          <div className="flex items-center gap-1 coarse:gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setFilters((f) => ({ ...f, offset: Math.max(0, (f.offset ?? 0) - limit) }))}
              className="px-2 py-1 coarse:px-4 coarse:py-2.5 rounded hover:text-text-primary disabled:opacity-30"
            >
              {t('audit.prev', 'Previous')}
            </button>
            <button
              type="button"
              disabled={page >= pages}
              onClick={() => setFilters((f) => ({ ...f, offset: (f.offset ?? 0) + limit }))}
              className="px-2 py-1 coarse:px-4 coarse:py-2.5 rounded hover:text-text-primary disabled:opacity-30"
            >
              {t('common.next')}
            </button>
          </div>
        </div>
      )}
    </PageContainer>
  );
}

// Searchable user picker kept inside the app theme (a native <select> opens
// with OS chrome on some platforms) — typing filters long user lists.
function UserCombobox({
  users,
  value,
  onChange,
}: {
  users: User[];
  value: number | null;
  onChange: (id: number | null) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const coarse = useIsCoarsePointer();
  const selected = users.find((u) => u.id === value) ?? null;

  useClickOutside(ref, () => setOpen(false), open);

  const q = query.trim().toLowerCase();
  const filtered = users.filter(
    (u) => !q || u.username.toLowerCase().includes(q) || (u.displayName ?? '').toLowerCase().includes(q),
  );
  const pick = (id: number | null) => { onChange(id); setOpen(false); setQuery(''); };

  return (
    <div ref={ref} className="relative min-w-[160px]">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 py-1.5 coarse:py-2 px-2 text-xs bg-bg-secondary rounded text-text-primary"
      >
        <span className="truncate">{selected ? selected.username : t('audit.anyUser', 'Any user')}</span>
        <ChevronDown className="w-3 h-3 text-text-muted shrink-0" />
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 z-20 w-full min-w-[200px] max-h-64 overflow-y-auto overscroll-contain bg-bg-secondary rounded shadow-xl">
          <div className="p-1.5 sticky top-0 bg-bg-secondary">
            <input
              autoFocus={!coarse}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('common.search')}
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="w-full px-2 py-1 coarse:py-2 text-xs bg-bg-tertiary rounded text-text-primary focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={() => pick(null)}
            className={clsx(
              'w-full text-left px-2.5 py-1.5 coarse:py-3 text-xs hover:bg-bg-tertiary',
              value === null ? 'text-accent' : 'text-text-muted',
            )}
          >
            {t('audit.anyUser', 'Any user')}
          </button>
          {filtered.length === 0 ? (
            <div className="px-2.5 py-2 text-xs text-text-muted italic">{t('common.noResults')}</div>
          ) : filtered.map((u) => (
            <button
              key={u.id}
              type="button"
              onClick={() => pick(u.id)}
              className={clsx(
                'w-full text-left px-2.5 py-1.5 coarse:py-3 text-xs hover:bg-bg-tertiary flex items-center gap-1.5',
                value === u.id ? 'text-accent' : 'text-text-primary',
              )}
            >
              <span className="truncate">{u.username}</span>
              {u.displayName && <span className="text-[10px] text-text-muted truncate">({u.displayName})</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
