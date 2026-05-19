import api from '../config/api';

// The configured axios instance already prepends `/api/v1`, so callers use
// `/me/sidebar` here (NOT `/api/v1/me/sidebar`).

export async function fetchSidebar() {
  const { data } = await api.get('/me/sidebar');
  return data;
}

export async function switchActiveRole(roleId) {
  const { data } = await api.post(`/me/active-role/${roleId}`);
  return data;
}
