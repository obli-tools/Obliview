import type { NotificationPlugin, NotificationPayload } from '../types';
import { statusIcon, STATUS_COLORS_HEX } from '../statusIcons';

export const discordPlugin: NotificationPlugin = {
  type: 'discord',
  name: 'Discord',
  description: 'Send to a Discord channel via webhook',
  configFields: [
    { key: 'webhookUrl', label: 'Discord Webhook URL', type: 'url', required: true, placeholder: 'https://discord.com/api/webhooks/...' },
    { key: 'username', label: 'Bot Username (optional)', type: 'text', placeholder: 'Obliview' },
  ],

  async send(config, payload) {
    const title = payload.isGroupNotification
      ? `${statusIcon(payload.newStatus)} Group Alert — ${payload.groupName}`
      : `${statusIcon(payload.newStatus)} ${payload.monitorName}`;

    const fields: { name: string; value: string; inline?: boolean }[] = [];
    if (!payload.isGroupNotification) {
      fields.push({ name: 'Status', value: payload.newStatus.toUpperCase(), inline: true });
    }
    if (payload.monitorUrl) {
      fields.push({ name: 'URL', value: payload.monitorUrl, inline: true });
    }
    if (payload.isGroupNotification && payload.failingMonitors?.length) {
      fields.push({ name: 'Affected monitors', value: payload.failingMonitors.join(', ') });
    }

    const embed = {
      title,
      description: payload.message || `Status changed: **${payload.oldStatus}** → **${payload.newStatus}**`,
      color: STATUS_COLORS_HEX[payload.newStatus] ?? 0x95a5a6,
      fields,
      timestamp: payload.timestamp,
    };

    const body: Record<string, unknown> = { embeds: [embed] };
    if (config.username) body.username = config.username;

    const res = await fetch(String(config.webhookUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`Discord returned ${res.status}: ${await res.text()}`);
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
