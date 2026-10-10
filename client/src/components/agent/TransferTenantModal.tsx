import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, ArrowRightLeft, Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { agentApi, type AgentApiKeyWithDefault } from '@/api/agent.api';
import { Button } from '@/components/common/Button';
import { Modal } from '@/components/common/Modal';
import { useConfirm } from '@/components/common/ConfirmDialog';
import { useTenantStore } from '@/store/tenantStore';
import { apiErrorMessage } from '@/utils/apiError';
import { AGENT_SELECT_CLS } from './ApproveAgentModal';

/**
 * Move one or more agents to another workspace (platform admin only, Obliance
 * TransferTenantModal port). Calls POST /agent/devices/batch/transfer.
 *
 * Server side (W4-B), in one transaction: the device takes the target
 * tenant and API key, its group is cleared, its agent monitor follows it,
 * and the agent-scoped notification bindings, maintenance windows and live
 * alerts of the old workspace are dropped. A 'reconfigure' command then
 * hands the new API key to the agent (immediately when its WebSocket is
 * open, otherwise on its next push).
 */
interface TransferTenantModalProps {
  /** Devices to move. They all live in `sourceTenantIds` (one entry outside the God View). */
  devices: Array<{ id: number; tenantId: number; name: string }>;
  onClose: () => void;
  /** Called after a successful transfer (reload the list / leave the detail page). */
  onTransferred?: () => void;
}

export function TransferTenantModal({ devices, onClose, onTransferred }: TransferTenantModalProps) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const tenants = useTenantStore((s) => s.tenants);
  const fetchTenants = useTenantStore((s) => s.fetchTenants);

  const sourceTenantIds = useMemo(() => new Set(devices.map((d) => d.tenantId)), [devices]);
  // A device can only move to a workspace it is not already in.
  const candidates = useMemo(
    () => tenants
      .filter((tn) => !(sourceTenantIds.size === 1 && sourceTenantIds.has(tn.id)))
      .sort((a, b) => a.name.localeCompare(b.name)),
    [tenants, sourceTenantIds],
  );

  const [targetTenantId, setTargetTenantId] = useState<number | null>(null);
  const [keys, setKeys] = useState<AgentApiKeyWithDefault[]>([]);
  const [loadingKeys, setLoadingKeys] = useState(false);
  const [targetKeyId, setTargetKeyId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (tenants.length === 0) void fetchTenants();
  }, [tenants.length, fetchTenants]);

  // Load the target workspace's keys whenever the target changes.
  useEffect(() => {
    setKeys([]);
    setTargetKeyId(null);
    if (targetTenantId == null) return;
    let cancelled = false;
    setLoadingKeys(true);
    agentApi.listKeys(targetTenantId)
      .then((ks) => {
        if (cancelled) return;
        setKeys(ks);
        if (ks.length > 0) setTargetKeyId(ks[0].id);
      })
      .catch(() => {
        if (!cancelled) toast.error(t('agents.transfer.loadKeysFailed', 'Failed to load the API keys of this workspace'));
      })
      .finally(() => {
        if (!cancelled) setLoadingKeys(false);
      });
    return () => { cancelled = true; };
  }, [targetTenantId, t]);

  const targetTenant = candidates.find((c) => c.id === targetTenantId) ?? null;
  const single = devices.length === 1 ? devices[0] : null;

  const submit = async () => {
    if (targetTenantId == null || targetKeyId == null || !targetTenant) return;
    const ok = await confirm({
      title: single
        ? t('agents.transfer.confirmTitle', 'Transfer "{{device}}" to {{tenant}}?', { device: single.name, tenant: targetTenant.name })
        : t('agents.transfer.confirmTitleBulk', 'Transfer {{count}} agent(s) to {{tenant}}?', { count: devices.length, tenant: targetTenant.name }),
      message: t(
        'agents.transfer.confirmMessage',
        "The group, the agent notification bindings, maintenance windows and live alerts of the current workspace are dropped, and the agent is reconfigured with the new API key.",
      ),
      confirmLabel: t('agents.transfer.submit', 'Transfer'),
    });
    if (!ok) return;
    setSubmitting(true);
    try {
      const res = await agentApi.batchTransfer(devices.map((d) => d.id), targetTenantId, targetKeyId);
      if (res.failed && res.failed > 0) {
        toast.error(t('agents.transfer.partial', '{{transferred}} transferred, {{failed}} failed', {
          transferred: res.transferred ?? devices.length - res.failed,
          failed: res.failed,
        }));
      } else {
        toast.success(t('agents.transfer.done', 'Transfer started: the agent switches to the new key on its next check-in.'));
      }
      onTransferred?.();
      onClose();
    } catch (err) {
      toast.error(apiErrorMessage(err, t('agents.transfer.failed', 'Transfer failed')));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={!submitting}
      size="md"
      icon={<ArrowRightLeft className="h-4 w-4 text-accent" />}
      title={t('agents.transfer.title', 'Transfer to another workspace')}
      bodyClassName="px-4 py-4 space-y-4"
      footerClassName="max-sm:[&>*]:flex-1"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={submitting}>{t('common.cancel')}</Button>
          <Button onClick={() => void submit()} loading={submitting} disabled={targetTenantId == null || targetKeyId == null}>
            {t('agents.transfer.submit', 'Transfer')}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-2 rounded-md border border-orange-400/20 bg-orange-400/5 p-2.5 text-xs text-orange-400/90">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p>
          {single
            ? t('agents.transfer.warningOne', 'This moves {{device}} to another workspace.', { device: single.name })
            : t('agents.transfer.warningMany', 'This moves {{count}} agent(s) to another workspace.', { count: devices.length })}{' '}
          {t(
            'agents.transfer.warningDetails',
            'Its group, agent notification bindings, maintenance windows and live alerts in the current workspace are cleared. The agent receives the new API key through a reconfigure command.',
          )}
        </p>
      </div>

      {candidates.length === 0 ? (
        <p className="text-sm italic text-text-muted">
          {t('agents.transfer.noCandidates', 'There is no other workspace to transfer to.')}
        </p>
      ) : (
        <>
          <div>
            <label htmlFor="transfer-tenant" className="mb-1.5 block text-xs font-medium text-text-secondary">
              {t('agents.transfer.targetTenant', 'Target workspace')}
            </label>
            <select
              id="transfer-tenant"
              value={targetTenantId ?? ''}
              onChange={(e) => setTargetTenantId(e.target.value ? Number(e.target.value) : null)}
              className={AGENT_SELECT_CLS}
            >
              <option value="">{t('agents.transfer.selectTenant', '— Select a workspace —')}</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>

          {targetTenant && (
            <div>
              <label htmlFor="transfer-key" className="mb-1.5 block text-xs font-medium text-text-secondary">
                {t('agents.transfer.targetKey', 'Target API key')}
              </label>
              {loadingKeys ? (
                <div className="flex justify-center py-3 text-text-muted">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : keys.length === 0 ? (
                <p className="text-xs text-red-400">
                  {t('agents.transfer.noKeys', 'This workspace has no API key yet. Create one in its agent configuration first.')}
                </p>
              ) : (
                <>
                  <select
                    id="transfer-key"
                    value={targetKeyId ?? ''}
                    onChange={(e) => setTargetKeyId(e.target.value ? Number(e.target.value) : null)}
                    className={AGENT_SELECT_CLS}
                  >
                    {keys.map((k) => (
                      <option key={k.id} value={k.id}>
                        {k.name || t('agents.transfer.keyFallback', 'Key #{{id}}', { id: k.id })}
                        {k.defaultGroupName ? ` (${k.defaultGroupName})` : ''}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-text-muted">
                    {t('agents.transfer.keyHint', 'The agent arrives without a group in the target workspace.')}
                  </p>
                </>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

export default TransferTenantModal;
