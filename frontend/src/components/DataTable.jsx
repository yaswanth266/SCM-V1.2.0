import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Table, Input, Button, Space, Tooltip, Empty } from 'antd';
import {
  SearchOutlined,
  DownloadOutlined,
  PrinterOutlined,
  ReloadOutlined,
  InboxOutlined,
} from '@ant-design/icons';
import { useReactToPrint } from 'react-to-print';
import { downloadExcel, debounce, formatDate } from '../utils/helpers';

const DataTable = ({
  columns,
  dataSource: externalData,
  fetchFunction,
  extraParams,
  rowKey = 'id',
  searchPlaceholder = 'Search...',
  showSearch = true,
  showExport = true,
  showPrint = true,
  showRefresh = true,
  exportFileName = 'export',
  pageSize: defaultPageSize = 20,
  pageSizeOptions = ['10', '20', '50', '100'],
  scroll,
  bordered = false,
  size = 'middle',
  title: tableTitle,
  toolbar,
  onRow,
  rowSelection,
  expandable,
  summary,
  loading: externalLoading,
  initialSearch = '',
  onExport,
  onPrint,
}) => {
  const [data, setData] = useState(externalData || []);
  const [loading, setLoading] = useState(false);
  const [searchText, setSearchText] = useState(initialSearch);
  const [pagination, setPagination] = useState({
    current: 1,
    pageSize: defaultPageSize,
    total: 0,
    showSizeChanger: true,
    pageSizeOptions,
    showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} items`,
  });
  const [sorter, setSorter] = useState({});
  const [filters, setFilters] = useState({});

  // extraParams: external filter values merged into every fetch call
  const extraParamsRef = useRef(extraParams || {});
  extraParamsRef.current = extraParams || {};
  const extraParamsJSON = JSON.stringify(extraParams || {});
  const printRef = useRef(null);

  const handlePrint = useReactToPrint({
    content: () => printRef.current,
    documentTitle: exportFileName,
  });

  const fetchFunctionRef = useRef(fetchFunction);
  fetchFunctionRef.current = fetchFunction;

  const fetchData = useCallback(
    async (params = {}) => {
      if (!fetchFunctionRef.current) return;
      setLoading(true);
      try {
        const queryParams = {
          page: params.current || pagination.current,
          page_size: params.pageSize || pagination.pageSize,
          search: params.search !== undefined ? params.search : searchText,
          ...(params.sortField && {
            sort_by: params.sortField,
            sort_order: params.sortOrder === 'ascend' ? 'asc' : 'desc',
          }),
          ...params.filters,
          // Merge in any external filter params (e.g. from filter dropdowns above the table)
          ...extraParamsRef.current,
        };

        Object.keys(queryParams).forEach((key) => {
          if (
            queryParams[key] === undefined ||
            queryParams[key] === null ||
            queryParams[key] === ''
          ) {
            delete queryParams[key];
          }
        });

        const response = await fetchFunctionRef.current(queryParams);
        const responseData = response.data || response;
        const items = responseData.items || responseData.data || responseData;
        const total =
          responseData.total
          || responseData.count
          || (responseData.pagination && responseData.pagination.total)
          || (Array.isArray(items) ? undefined : 0);

        const itemsArray = Array.isArray(items) ? items : [];
        setData(itemsArray);
        setPagination((prev) => ({
          ...prev,
          current: params.current || prev.current,
          pageSize: params.pageSize || prev.pageSize,
          total: total != null ? total : itemsArray.length,
        }));
      } catch (error) {
        console.error('DataTable fetch error:', error);
        setData([]);
      } finally {
        setLoading(false);
      }
    },
    [pagination.current, pagination.pageSize, searchText]
  );

  // Fetch on mount AND whenever extraParams change (filter selections).
  // This replaces the previous mount-only useEffect([], []) so that
  // changing a filter dropdown immediately re-fetches page 1.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (fetchFunctionRef.current) {
      fetchData({ current: 1 });
    }
  }, [extraParamsJSON]);

  useEffect(() => {
    if (externalData) {
      setData(externalData);
      setPagination((prev) => ({
        ...prev,
        total: externalData.length,
      }));
    }
  }, [externalData]);

  const debouncedSearch = useCallback(
    debounce((value) => {
      if (fetchFunction) {
        fetchData({ current: 1, search: value });
      }
    }, 400),
    [fetchFunction]
  );

  useEffect(() => {
    return () => {
      debouncedSearch.cancel();
    };
  }, [debouncedSearch]);

  const handleSearchChange = (e) => {
    const value = e.target.value;
    setSearchText(value);
    if (fetchFunction) {
      debouncedSearch(value);
    }
  };

  const handleTableChange = (pag, tableFilters, tableSorter) => {
    setSorter(tableSorter);
    setFilters(tableFilters);
    if (fetchFunction) {
      fetchData({
        current: pag.current,
        pageSize: pag.pageSize,
        sortField: tableSorter.field,
        sortOrder: tableSorter.order,
        filters: tableFilters,
      });
    } else {
      setPagination((prev) => ({
        ...prev,
        current: pag.current,
        pageSize: pag.pageSize,
      }));
    }
  };

  const handleExport = async () => {
    if (onExport) {
      onExport(filteredData);
      return;
    }

    let exportRawData = data;

    // If server-side pagination (fetchFunction) is enabled, fetch all records matching current filters
    if (fetchFunction) {
      setLoading(true);
      try {
        const queryParams = {
          page: 1,
          page_size: 100000, // Enforce fetching all matching records
          search: searchText,
          ...(sorter.field && {
            sort_by: sorter.field,
            sort_order: sorter.order === 'ascend' ? 'asc' : 'desc',
          }),
          ...filters,
          ...extraParamsRef.current,
        };

        Object.keys(queryParams).forEach((key) => {
          if (
            queryParams[key] === undefined ||
            queryParams[key] === null ||
            queryParams[key] === ''
          ) {
            delete queryParams[key];
          }
        });

        const response = await fetchFunction(queryParams);
        const responseData = response.data || response;
        const items = responseData.items || responseData.data || responseData;
        if (Array.isArray(items)) {
          exportRawData = items;
        }
      } catch (error) {
        console.error('Error fetching all data for export:', error);
      } finally {
        setLoading(false);
      }
    }

    const exportData = exportRawData.map((row) => {
      const exportRow = {};
      columns.forEach((col) => {
        if (col.dataIndex && col.title) {
          const key =
            typeof col.dataIndex === 'string'
              ? col.dataIndex
              : col.dataIndex.join('.');
          let value = row;
          if (typeof col.dataIndex === 'string') {
            value = row[col.dataIndex];
          } else if (Array.isArray(col.dataIndex)) {
            value = col.dataIndex.reduce(
              (obj, k) => (obj ? obj[k] : undefined),
              row
            );
          }
          const title =
            typeof col.title === 'string' ? col.title : key;

          // If the key suggests a date, format it nicely using the formatDate utility
          const lowerKey = key.toLowerCase();
          if ((lowerKey.includes('date') || lowerKey.includes('time') || lowerKey.includes('at')) && value) {
            try {
              value = formatDate(value);
            } catch {}
          }

          exportRow[title] = value !== null && value !== undefined ? value : '-';
        }
      });
      return exportRow;
    });
    downloadExcel(exportData, exportFileName);
  };

  const onPrintClick = async () => {
    if (onPrint) {
      onPrint(filteredData);
      return;
    }

    let printRawData = data;

    // If server-side pagination (fetchFunction) is enabled, fetch all records matching current filters
    if (fetchFunction) {
      setLoading(true);
      try {
        const queryParams = {
          page: 1,
          page_size: 100000, // Enforce fetching all matching records
          search: searchText,
          ...(sorter.field && {
            sort_by: sorter.field,
            sort_order: sorter.order === 'ascend' ? 'asc' : 'desc',
          }),
          ...filters,
          ...extraParamsRef.current,
        };

        Object.keys(queryParams).forEach((key) => {
          if (
            queryParams[key] === undefined ||
            queryParams[key] === null ||
            queryParams[key] === ''
          ) {
            delete queryParams[key];
          }
        });

        const response = await fetchFunction(queryParams);
        const responseData = response.data || response;
        const items = responseData.items || responseData.data || responseData;
        if (Array.isArray(items)) {
          printRawData = items;
        }
      } catch (error) {
        console.error('Error fetching all data for print:', error);
      } finally {
        setLoading(false);
      }
    }

    const printWindow = window.open('', '_blank');
    
    // Build columns headers
    let headersHTML = '<tr>';
    columns.forEach((col) => {
      if (col.title && col.key !== 'actions') {
        headersHTML += `<th>${typeof col.title === 'string' ? col.title : col.key || ''}</th>`;
      }
    });
    headersHTML += '</tr>';

    // Build rows
    let rowsHTML = '';
    printRawData.forEach((row, rIdx) => {
      rowsHTML += '<tr>';
      columns.forEach((col) => {
        if (col.title && col.key !== 'actions') {
          let value = row;
          if (col.dataIndex) {
            if (typeof col.dataIndex === 'string') {
              value = row[col.dataIndex];
            } else if (Array.isArray(col.dataIndex)) {
              value = col.dataIndex.reduce((o, k) => (o ? o[k] : undefined), row);
            }
          }

          let displayVal = value !== null && value !== undefined ? String(value) : '-';

          // Call custom render if it exists and returns a simple type
          if (col.render) {
            try {
              const rendered = col.render(value, row, rIdx);
              if (typeof rendered === 'string' || typeof rendered === 'number') {
                displayVal = String(rendered);
              } else if (React.isValidElement(rendered)) {
                // If it's a Tag or element with text children
                if (rendered.props && rendered.props.children !== undefined) {
                  if (typeof rendered.props.children === 'string') {
                    displayVal = rendered.props.children;
                  } else if (Array.isArray(rendered.props.children)) {
                    displayVal = rendered.props.children.filter(c => typeof c === 'string').join(' ');
                  }
                }
              }
            } catch {}
          }

          const lowerKey = String(col.dataIndex || col.key || '').toLowerCase();
          if ((lowerKey.includes('date') || lowerKey.includes('time') || lowerKey.includes('at')) && value) {
            try {
              displayVal = formatDate(value);
            } catch {}
          }

          rowsHTML += `<td>${displayVal}</td>`;
        }
      });
      rowsHTML += '</tr>';
    });

    printWindow.document.write(`
      <html>
        <head>
          <title>${exportFileName.replace(/_/g, ' ')}</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; padding: 25px; color: #1e293b; }
            .report-header { text-align: center; color: #1e3a8a; font-size: 20px; font-weight: bold; margin-bottom: 20px; text-transform: uppercase; border-bottom: 3px solid #1e3a8a; padding-bottom: 12px; }
            .print-table { width: 100%; border-collapse: collapse; margin-top: 10px; }
            .print-table th { background-color: #f8fafc; color: #0f172a; padding: 10px 12px; border: 1px solid #cbd5e1; text-align: left; font-weight: bold; font-size: 11px; text-transform: uppercase; }
            .print-table td { padding: 9px 12px; border: 1px solid #cbd5e1; font-size: 11px; color: #334155; }
            .print-table tr:nth-child(even) { background-color: #f8fafc; }
            .no-print-btn { background-color: #1e3a8a; color: white; padding: 10px 20px; border: none; border-radius: 6px; font-weight: bold; cursor: pointer; margin-bottom: 20px; font-size: 12px; }
            .no-print-btn:hover { background-color: #1d4ed8; }
            @media print {
              .no-print-btn { display: none; }
              body { padding: 10px; }
            }
          </style>
        </head>
        <body>
          <button class="no-print-btn" onclick="window.print()">Print / Save as PDF</button>
          <div class="report-header">${exportFileName.replace(/_/g, ' ')}</div>
          <table class="print-table">
            <thead>
              ${headersHTML}
            </thead>
            <tbody>
              ${rowsHTML}
            </tbody>
          </table>
        </body>
      </html>
    `);
    printWindow.document.close();
    setTimeout(() => {
      printWindow.focus();
    }, 300);
  };

  const handleRefresh = () => {
    if (fetchFunction) {
      fetchData();
    }
  };

  const filteredData =
    !fetchFunction && searchText
      ? data.filter((row) =>
          Object.values(row).some((val) =>
            String(val || '')
              .toLowerCase()
              .includes(searchText.toLowerCase())
          )
        )
      : data;

  const isLoading =
    externalLoading !== undefined ? externalLoading : loading;

  return (
    <div className="data-table-wrapper" ref={printRef}>
      <div className="data-table-toolbar">
        <div className="data-table-toolbar-left">
          {showSearch && (
            <Input
              placeholder={searchPlaceholder}
              prefix={<SearchOutlined style={{ color: '#bfbfbf' }} />}
              value={searchText}
              onChange={handleSearchChange}
              allowClear
              style={{ width: 280 }}
            />
          )}
          {toolbar}
        </div>
        <div className="data-table-toolbar-right no-print">
          {showRefresh && fetchFunction && (
            <Tooltip title="Refresh">
              <Button
                icon={<ReloadOutlined />}
                onClick={handleRefresh}
                loading={isLoading}
              />
            </Tooltip>
          )}
          {showExport && (
            <Tooltip title="Export to Excel">
              <Button
                icon={<DownloadOutlined />}
                onClick={handleExport}
                disabled={filteredData.length === 0}
              />
            </Tooltip>
          )}
          {showPrint && (
            <Tooltip title="Print">
              <Button
                icon={<PrinterOutlined />}
                onClick={onPrintClick}
                disabled={filteredData.length === 0}
              />
            </Tooltip>
          )}
        </div>
      </div>
      <Table
        columns={columns}
        dataSource={filteredData}
        rowKey={rowKey}
        loading={isLoading}
        pagination={
          fetchFunction
            ? pagination
            : {
                ...pagination,
                total: filteredData.length,
                showSizeChanger: true,
                showTotal: (total, range) =>
                  `${range[0]}-${range[1]} of ${total} items`,
              }
        }
        onChange={handleTableChange}
        scroll={scroll || { x: 'max-content' }}
        bordered={bordered}
        size={size}
        onRow={onRow}
        rowSelection={rowSelection}
        expandable={expandable}
        summary={summary}
        locale={{
          emptyText: (
            <Empty
              image={<InboxOutlined style={{ fontSize: 64, color: '#d9d9d9' }} />}
              description={
                searchText
                  ? 'No results match your search'
                  : 'No data available'
              }
            />
          ),
        }}
      />
    </div>
  );
};

export default DataTable;
