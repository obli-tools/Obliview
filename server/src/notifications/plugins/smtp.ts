import type { NotificationPlugin, NotificationPayload } from '../types';
import nodemailer from 'nodemailer';
import { statusIcon } from '../statusIcons';

export const smtpPlugin: NotificationPlugin = {
  type: 'smtp',
  name: 'Email (SMTP)',
  description: 'Send email notifications via a global SMTP server',
  configFields: [
    { key: 'smtpServerId', label: 'SMTP Server', type: 'smtp_server_select', required: true },
    { key: 'fromOverride', label: 'From Address Override', type: 'text', required: false, placeholder: 'Leave blank to use server default' },
    { key: 'to', label: 'To Address(es)', type: 'text', required: true, placeholder: 'admin@example.com' },
  ],

  // config here is the RESOLVED config (host/port/etc injected by resolveChannelConfig)
  async send(config, payload) {
    const icon = statusIcon(payload.newStatus);
    const transport = nodemailer.createTransport({
      host: String(config.host),
      port: Number(config.port),
      secure: Boolean(config.secure),
      auth: {
        user: String(config.username),
        pass: String(config.password),
      },
    });

    const subject = payload.isGroupNotification
      ? `${icon} Group "${payload.groupName}" — ${payload.totalFailingCount ?? 1} monitor(s) failing`
      : `${icon} ${payload.monitorName} is ${payload.newStatus.toUpperCase()}`;
    const heading = payload.isGroupNotification
      ? `${icon} Group Alert — ${payload.groupName}`
      : `${icon} ${payload.monitorName}`;
    const affectedText = payload.isGroupNotification && payload.failingMonitors?.length
      ? `Affected: ${payload.failingMonitors.join(', ')}`
      : '';
    const affectedHtml = payload.isGroupNotification && payload.failingMonitors?.length
      ? `<p><strong>Affected:</strong> ${payload.failingMonitors.join(', ')}</p>`
      : '';

    await transport.sendMail({
      from: String(config.from),
      to: String(config.to),
      subject,
      text: [
        heading,
        payload.isGroupNotification
          ? `${payload.totalFailingCount ?? 1} monitor(s) affected`
          : `Status: ${payload.oldStatus} → ${payload.newStatus}`,
        payload.message ? `Message: ${payload.message}` : '',
        affectedText,
        payload.monitorUrl ? `URL: ${payload.monitorUrl}` : '',
        `Time: ${payload.timestamp}`,
      ].filter(Boolean).join('\n'),
      html: [
        `<h2>${heading}</h2>`,
        payload.isGroupNotification
          ? `<p><strong>${payload.totalFailingCount ?? 1} monitor(s) affected</strong></p>`
          : `<p><strong>Status:</strong> ${payload.oldStatus} → <strong>${payload.newStatus.toUpperCase()}</strong></p>`,
        payload.message ? `<p>${payload.message}</p>` : '',
        affectedHtml,
        payload.monitorUrl ? `<p><a href="${payload.monitorUrl}">${payload.monitorUrl}</a></p>` : '',
        `<p><small>${payload.timestamp}</small></p>`,
      ].filter(Boolean).join('\n'),
    });
  },

  async sendTest(config) {
    await this.send(config, {
      monitorName: 'Test Monitor',
      oldStatus: 'up',
      newStatus: 'down',
      message: 'Test from Obliview',
      timestamp: new Date().toISOString(),
    });
  },
};
