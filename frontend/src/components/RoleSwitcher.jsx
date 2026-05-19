import { useState } from 'react';
import { Dropdown, Button, message } from 'antd';
import { DownOutlined } from '@ant-design/icons';
import useAuthStore from '../store/authStore';
import { switchActiveRole } from '../api/sidebar';

export default function RoleSwitcher() {
  const user = useAuthStore((s) => s.user);
  const activeRoleCode = useAuthStore((s) => s.activeRoleCode);
  const setSidebar = useAuthStore((s) => s.setSidebar);
  const [switching, setSwitching] = useState(false);
  if (!user || !user.roles || user.roles.length < 2) return null;

  const onSwitch = async (roleId) => {
    if (switching) return;
    setSwitching(true);
    try {
      const resp = await switchActiveRole(roleId);
      setSidebar(resp);
      message.success(`Acting as: ${resp.active_role_code}`);
      window.location.href = '/dashboard';
    } catch (e) {
      const detail = e?.response?.data?.detail;
      message.error(typeof detail === 'string' ? detail : 'Could not switch role');
      setSwitching(false);
    }
  };

  const items = user.roles.map((r) => ({
    key: r.id,
    label: r.name,
    onClick: () => onSwitch(r.id),
  }));

  const activeName =
    user.roles.find((r) => r.code === activeRoleCode)?.name || 'Switch role';

  return (
    <Dropdown menu={{ items }} disabled={switching} trigger={['click']}>
      <Button
        type="text"
        loading={switching}
        disabled={switching}
        style={{
          color: 'rgba(255,255,255,0.92)',
          padding: '4px 10px',
          height: 36,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        Acting as: {activeName} <DownOutlined style={{ fontSize: 11 }} />
      </Button>
    </Dropdown>
  );
}
