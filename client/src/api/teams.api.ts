import apiClient from './client';
import type {
  UserTeam,
  TeamPermission,
  ApiResponse,
  CreateTeamRequest,
  UpdateTeamRequest,
  SetTeamMembersRequest,
  SetTeamPermissionsRequest,
} from '@obliview/shared';

interface TeamDetail extends UserTeam {
  memberIds: number[];
  permissions: TeamPermission[];
}

export const teamsApi = {
  async list(): Promise<UserTeam[]> {
    const res = await apiClient.get<ApiResponse<UserTeam[]>>('/teams');
    return res.data.data!;
  },

  async getById(id: number): Promise<TeamDetail> {
    const res = await apiClient.get<ApiResponse<TeamDetail>>(`/teams/${id}`);
    return res.data.data!;
  },

  /**
   * Teams are strictly mono-tenant. `tenantId` is required from the god view
   * (master tenant, platform admin) and ignored by the server elsewhere.
   */
  async create(data: CreateTeamRequest & { tenantId?: number }): Promise<UserTeam> {
    const res = await apiClient.post<ApiResponse<UserTeam>>('/teams', data);
    return res.data.data!;
  },

  async update(id: number, data: UpdateTeamRequest): Promise<UserTeam> {
    const res = await apiClient.put<ApiResponse<UserTeam>>(`/teams/${id}`, data);
    return res.data.data!;
  },

  async delete(id: number): Promise<void> {
    await apiClient.delete(`/teams/${id}`);
  },

  async getMembers(id: number): Promise<number[]> {
    const res = await apiClient.get<ApiResponse<number[]>>(`/teams/${id}/members`);
    return res.data.data!;
  },

  async setMembers(id: number, data: SetTeamMembersRequest): Promise<void> {
    await apiClient.put(`/teams/${id}/members`, data);
  },

  async getPermissions(id: number): Promise<TeamPermission[]> {
    const res = await apiClient.get<ApiResponse<TeamPermission[]>>(`/teams/${id}/permissions`);
    return res.data.data!;
  },

  async setPermissions(id: number, data: SetTeamPermissionsRequest): Promise<TeamPermission[]> {
    const res = await apiClient.put<ApiResponse<TeamPermission[]>>(`/teams/${id}/permissions`, data);
    return res.data.data!;
  },

  async removePermission(teamId: number, permId: number): Promise<void> {
    await apiClient.delete(`/teams/${teamId}/permissions/${permId}`);
  },
};
