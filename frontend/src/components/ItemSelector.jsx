import React, { useState, useCallback, useEffect } from 'react';
import { Select, Spin, message } from 'antd';
import { debounce } from '../utils/helpers';
import api from '../config/api';

const ItemSelector = ({
  value,
  onChange,
  placeholder = 'Search items by code or name...',
  apiUrl = '/masters/items',
  mode,
  disabled = false,
  allowClear = true,
  style,
  showCode = true,
  extraParams = {},
  excludeIds = [],
}) => {
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!value) return;
    const ids = Array.isArray(value) ? value : [value];
    const missingIds = ids.filter(id => !options.find(o => o.value === id));
    if (missingIds.length > 0) {
      setLoading(true);
      Promise.all(missingIds.map(id => api.get(`${apiUrl}/${id}`)))
        .then(results => {
          const newOpts = results.map(res => {
            const item = res.data;
            return {
              label: showCode
                ? `[${item.item_code || item.code}] ${item.item_name || item.name}`
                : item.item_name || item.name,
              value: item.id,
              item,
            };
          });
          setOptions(prev => {
            const existing = new Set(prev.map(o => o.value));
            const filtered = newOpts.filter(o => !existing.has(o.value));
            return [...prev, ...filtered];
          });
        })
        .catch(err => {
          console.error("Failed to load initial items in ItemSelector", err);
        })
        .finally(() => {
          setLoading(false);
        });
    }
  }, [value, apiUrl, showCode]);

  const fetchItems = useCallback(
    debounce(async (search) => {
      if (!search || search.length < 2) {
        setOptions([]);
        return;
      }
      setLoading(true);
      try {
        const params = { search, page_size: 30, is_active: true, transactable: true, ...extraParams };
        const response = await api.get(apiUrl, { params });
        const data = response.data;
        const items = data.items || data.data || data || [];
        const excludeSet = new Set((excludeIds || []).map(Number));
        const filteredItems = items.filter(
          (item) => !excludeSet.has(Number(item.id)) || Number(item.id) === Number(value)
        );
        const mapped = filteredItems.map((item) => ({
          label: showCode
            ? `[${item.item_code || item.code}] ${item.item_name || item.name}`
            : item.item_name || item.name,
          value: item.id,
          item,
        }));
        setOptions(mapped);
      } catch (error) {
        console.error('ItemSelector fetch error:', error);
        message.error('Failed to load items. Please try again.');
        setOptions([]);
      } finally {
        setLoading(false);
      }
    }, 300),
    [apiUrl, showCode, extraParams, excludeIds, value]
  );

  const handleSearch = (search) => {
    fetchItems(search);
  };

  const handleChange = (val, option) => {
    if (onChange) {
      if (mode === 'multiple') {
        const selected = Array.isArray(option)
          ? option.map((o) => o.item || o)
          : [];
        onChange(val, selected);
      } else {
        onChange(val, option?.item || null);
      }
    }
  };

  const excludeSet = new Set((excludeIds || []).map(Number));
  const filteredOptions = options.filter(
    (opt) => !excludeSet.has(Number(opt.value)) || Number(opt.value) === Number(value)
  );

  return (
    <Select
      showSearch
      value={value}
      onChange={handleChange}
      onSearch={handleSearch}
      placeholder={placeholder}
      filterOption={false}
      options={filteredOptions}
      notFoundContent={
        loading ? <Spin size="small" /> : filteredOptions.length === 0 ? 'Type to search items' : null
      }
      mode={mode}
      disabled={disabled}
      allowClear={allowClear}
      style={{ width: '100%', ...style }}
      loading={loading}
    />
  );
};

export default ItemSelector;
