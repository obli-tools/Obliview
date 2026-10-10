import type { NotificationPlugin, NotificationPayload } from '../types';
import { statusIcon } from '../statusIcons';

export const telegramPlugin: NotificationPlugin = {
  type: 'telegram',
  name: 'Telegram',
  description: 'Send to a Telegram chat via bot',
  configFields: [
    { key: 'botToken', label: 'Bot Token', type: 'password', required: true, placeholder: '123456:ABC-DEF...' },
    { key: 'chatId', label: 'Chat ID', type: 'text', required: true, placeholder: '-1001234567890' },
  ],

  async send(config, payload) {
    const icon = statusIcon(payload.newStatus);
    const header = payload.isGroupNotification
      ? `${icon} <b>Group Alert — ${payload.groupName}</b>`
      : `${icon} <b>${payload.monitorName}</b>`;
    const status = payload.isGroupNotification
      ? `${payload.totalFailingCount ?? payload.failingMonitors?.length ?? 0} monitor(s) affected`
      : `Status: <b>${payload.oldStatus.toUpperCase()}</b> → <b>${payload.newStatus.toUpperCase()}</b>`;
    const affected = payload.isGroupNotification && payload.failingMonitors?.length
      ? `\nAffected: ${payload.failingMonitors.join(', ')}`
      : '';
    const text = [
      header,
      status,
      payload.message ? `\n${payload.message}` : '',
      affected,
      payload.monitorUrl ? `\n🔗 ${payload.monitorUrl}` : '',
    ].filter(Boolean).join('\n');

    const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Telegram returned ${res.status}: ${await res.text()}`);
  },

  async sendTest(config) {
    await this.send(config, {
      monitorName: 'Test Monitor',
      oldStatus: 'up',
      newStatus: 'down',
      message: 'This is a test notification from Obliview',
      timestamp: new Date().toISOString(),
    });
  },
};
