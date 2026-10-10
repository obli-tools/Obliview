import type { Knex } from 'knex';
import { db } from '../db';
import nodemailer from 'nodemailer';
import type { SmtpServer } from '@obliview/shared';
import { MASTER_TENANT_ID } from '@obliview/shared';
import { appConfigService } from './appConfig.service';

interface SmtpServerRow {
  id: number;
  name: string;
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from_address: string;
  tenant_id: number | null;
  created_at: Date;
  updated_at: Date;
}

/** A server with its owner: tenant_id NULL = platform-level (2FA / password reset only). */
export type SmtpServerWithTenant = SmtpServer & { tenantId: number | null };

function rowToServer(row: SmtpServerRow): SmtpServer {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    secure: row.secure,
    username: row.username,
    fromAddress: row.from_address,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

/**
 * Restrict a smtp_servers query to one tenant. `tenantScope` null = god view
 * (platform admin on the master workspace): no restriction, so platform-level
 * servers (tenant_id NULL) and every workspace's servers are reachable.
 */
function whereInTenantScope<Q extends Knex.QueryBuilder>(query: Q, tenantScope: number | null): Q {
  if (tenantScope !== null) query.where({ tenant_id: tenantScope });
  return query;
}

export const smtpServerService = {
  /** Servers of one workspace (always tenant-scoped: listings never fan out). */
  async list(tenantId: number): Promise<SmtpServer[]> {
    const rows = await db<SmtpServerRow>('smtp_servers').where({ tenant_id: tenantId }).orderBy('name');
    return rows.map(rowToServer);
  },

  /**
   * Servers that may send the platform-wide 2FA codes and password-reset
   * emails (app_config otp_smtp_server_id): the platform-level ones
   * (tenant_id NULL) and the master workspace's. `includeId` (the server
   * currently configured) is always listed, wherever it lives, so the
   * setting never shows "None" while a server is in use.
   */
  async listOtpCandidates(includeId?: number | null): Promise<SmtpServerWithTenant[]> {
    const rows = await db<SmtpServerRow>('smtp_servers')
      .where((qb) => {
        qb.whereNull('tenant_id').orWhere('tenant_id', MASTER_TENANT_ID);
        if (includeId) qb.orWhere('id', includeId);
      })
      .orderBy('name');
    return rows.map((row) => ({ ...rowToServer(row), tenantId: row.tenant_id }));
  },

  /** Id of the server configured for 2FA / password-reset emails (app_config), if any. */
  async getOtpServerId(): Promise<number | null> {
    const raw = await appConfigService.get('otp_smtp_server_id');
    const id = raw ? parseInt(raw, 10) : NaN;
    return Number.isInteger(id) && id > 0 ? id : null;
  },

  // UNSAFE without tenant scope — internal use only (2FA / password-reset
  // sender, channel transport resolution). Request paths go through the
  // tenant-scoped update / delete / test below.
  async getById(id: number): Promise<SmtpServerRow | null> {
    const row = await db<SmtpServerRow>('smtp_servers').where({ id }).first();
    return row || null;
  },

  /** Owner of a server: undefined = no such server, null = platform-level. */
  async getTenantId(id: number): Promise<number | null | undefined> {
    const row = await db<SmtpServerRow>('smtp_servers').where({ id }).first('tenant_id');
    return row ? row.tenant_id : undefined;
  },

  async create(data: {
    name: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromAddress: string;
    tenantId?: number;
  }): Promise<SmtpServer> {
    const [row] = await db<SmtpServerRow>('smtp_servers')
      .insert({
        name: data.name,
        host: data.host,
        port: data.port,
        secure: data.secure,
        username: data.username,
        password: data.password,
        from_address: data.fromAddress,
        tenant_id: data.tenantId ?? null,
      })
      .returning('*');
    return rowToServer(row);
  },

  async update(id: number, data: Partial<{
    name: string;
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    fromAddress: string;
  }>, tenantScope: number | null): Promise<SmtpServer | null> {
    const update: Record<string, unknown> = { updated_at: new Date() };
    if (data.name !== undefined) update.name = data.name;
    if (data.host !== undefined) update.host = data.host;
    if (data.port !== undefined) update.port = data.port;
    if (data.secure !== undefined) update.secure = data.secure;
    if (data.username !== undefined) update.username = data.username;
    if (data.password !== undefined) update.password = data.password;
    if (data.fromAddress !== undefined) update.from_address = data.fromAddress;

    // WHERE id AND tenant_id (god view: id only)
    const query = whereInTenantScope(db<SmtpServerRow>('smtp_servers').where({ id }), tenantScope);
    const [row] = await query.update(update).returning('*');
    return row ? rowToServer(row) : null;
  },

  /** Delete, tenant-gated (`tenantScope` null = god view). False when nothing matched. */
  async delete(id: number, tenantScope: number | null): Promise<boolean> {
    const count = await whereInTenantScope(db('smtp_servers').where({ id }), tenantScope).del();
    return count > 0;
  },

  /** Verify the connection, tenant-gated (`tenantScope` null = god view). */
  async test(id: number, tenantScope: number | null): Promise<void> {
    const row = await whereInTenantScope(db<SmtpServerRow>('smtp_servers').where({ id }), tenantScope).first();
    if (!row) throw new Error('SMTP server not found');

    const transport = nodemailer.createTransport({
      host: row.host,
      port: row.port,
      secure: row.secure,
      auth: { user: row.username, pass: row.password },
    });

    await transport.verify();
  },

  /** Build a nodemailer transport config from a server row */
  async getTransportConfig(id: number): Promise<{ host: string; port: number; secure: boolean; username: string; password: string; fromAddress: string } | null> {
    const row = await this.getById(id);
    if (!row) return null;
    return {
      host: row.host,
      port: row.port,
      secure: row.secure,
      username: row.username,
      password: row.password,
      fromAddress: row.from_address,
    };
  },
};
