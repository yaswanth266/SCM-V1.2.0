import { useState } from 'react';
import { Dropdown, message } from 'antd';
import { DownOutlined, ApartmentOutlined, UserSwitchOutlined, LoadingOutlined } from '@ant-design/icons';
import useAuthStore from '../store/authStore';
import { switchActiveRole, switchActivePosition } from '../api/sidebar';

export default function RoleSwitcher() {
  const user = useAuthStore((s) => s.user);
  const activeRoleCode = useAuthStore((s) => s.activeRoleCode);
  const setSidebar = useAuthStore((s) => s.setSidebar);
  const refreshUser = useAuthStore((s) => s.refreshUser);
  const [switching, setSwitching] = useState(false);

  if (!user) return null;

  const hasMultiplePositions = user.positions && user.positions.length > 1;
  const hasMultipleRoles = user.roles && user.roles.length > 1;

  if (!hasMultiplePositions && !hasMultipleRoles) return null;

  if (hasMultiplePositions) {
    const onSwitchPosition = async (positionId) => {
      if (switching) return;
      setSwitching(true);
      try {
        const resp = await switchActivePosition(positionId);
        setSidebar(resp);
        await refreshUser();
        message.success(`Switched position`);
        window.location.href = '/dashboard';
      } catch (e) {
        const detail = e?.response?.data?.detail;
        message.error(typeof detail === 'string' ? detail : 'Could not switch position');
        setSwitching(false);
      }
    };

    const items = user.positions.map((p) => ({
      key: p.id,
      label: p.name + (p.role_name ? ` (${p.role_name})` : ''),
      onClick: () => onSwitchPosition(p.id),
    }));

    const activePosition = user.positions.find((p) => p.id === user.position_id);
    const displayName = activePosition ? activePosition.name : 'Switch position';

    return (
      <Dropdown menu={{ items }} disabled={switching} trigger={['click']} placement="bottomRight">
        <div
          className={`bavya-launcher-switcher-capsule ${switching ? 'switching' : ''}`}
          role="button"
          tabIndex={0}
        >
          {switching ? (
            <LoadingOutlined style={{ color: '#481890', fontSize: '15px' }} />
          ) : (
            <ApartmentOutlined style={{ color: '#481890', fontSize: '15px' }} />
          )}
          <span className="bavya-launcher-profile-name">
            Position: {displayName}
          </span>
          <DownOutlined style={{ fontSize: '10px', color: 'rgba(0,0,0,0.45)', marginLeft: '2px' }} />
        </div>
      </Dropdown>
    );
  }

  // Fallback to role switcher
  const onSwitchRole = async (roleId) => {
    if (switching) return;
    setSwitching(true);
    try {
      const resp = await switchActiveRole(roleId);
      setSidebar(resp);
      await refreshUser();
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
    onClick: () => onSwitchRole(r.id),
  }));

  const activeName =
    user.roles.find((r) => r.code === activeRoleCode)?.name || 'Switch role';

  return (
    <Dropdown menu={{ items }} disabled={switching} trigger={['click']} placement="bottomRight">
      <div
        className={`bavya-launcher-switcher-capsule ${switching ? 'switching' : ''}`}
        role="button"
        tabIndex={0}
      >
        {switching ? (
          <LoadingOutlined style={{ color: '#481890', fontSize: '15px' }} />
        ) : (
          <UserSwitchOutlined style={{ color: '#481890', fontSize: '15px' }} />
        )}
        <span className="bavya-launcher-profile-name">
          Role: {activeName}
        </span>
        <DownOutlined style={{ fontSize: '10px', color: 'rgba(0,0,0,0.45)', marginLeft: '2px' }} />
      </div>
    </Dropdown>
  );
}
