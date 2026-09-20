var LineSightEDA = (function () {
  "use strict";

  const DEFAULT_MAX_ROWS_PER_SHEET = 50000;
  const FIELD_HINTS = {
    line: ["產線", "線別", "線體", "line", "productionline", "machine", "機台"],
    yield: ["良率", "yield", "yieldrate", "合格率"],
    good: ["良品數", "良品", "goodqty", "goodquantity", "passqty", "合格數"],
    total: ["總數", "投入數", "檢驗數", "產量", "totalqty", "quantity", "qty"],
    defect: ["不良原因", "缺陷類型", "異常類型", "defect", "defecttype", "ngreason"],
    timestamp: ["時間", "日期", "datetime", "timestamp", "date", "time"],
    parameter: ["參數", "設定值", "實際值", "溫度", "壓力", "電流", "電壓", "速度", "米速", "張力", "厚度", "parameter", "setpoint", "temperature", "pressure", "current", "voltage", "speed"],
    abnormal: ["異常", "不良", "缺陷", "原因", "處置", "改善", "責任", "defect", "abnormal", "failure", "cause", "disposition"],
  };

  function normalizeName(value) {
    return String(value ?? "")
      .trim()
      .toLowerCase()
      .replace(/[\s_\-./()（）]+/g, "");
  }

  function isBlank(value) {
    return value === null || value === undefined || (typeof value === "string" && value.trim() === "");
  }

  function asNumber(value) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "string") return null;
    const cleaned = value.trim().replace(/,/g, "").replace(/%$/, "");
    if (!cleaned || !/^[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?$/.test(cleaned)) return null;
    const number = Number(cleaned);
    return Number.isFinite(number) ? number : null;
  }

  function findColumn(columns, role) {
    const normalized = columns.map((name) => ({ name, normalized: normalizeName(name) }));
    const hints = FIELD_HINTS[role] || [];
    for (const hint of hints) {
      const exact = normalized.find((item) => item.normalized === hint);
      if (exact) return exact.name;
    }
    for (const hint of hints) {
      const partial = normalized.find((item) => item.normalized.includes(hint));
      if (partial) return partial.name;
    }
    return null;
  }

  function detectDataType(fileName, columns, requestedType) {
    if (["production_parameters", "abnormal_records"].includes(requestedType)) {
      return { value: requestedType, source: "manual", confidence: 1, reasons: ["使用者手動指定"] };
    }
    const normalizedFile = normalizeName(fileName);
    let productionScore = /(生產參數|製程參數|productionparameter|processparameter)/.test(normalizedFile) ? 4 : 0;
    let abnormalScore = /(異常紀錄|品質異常|不良紀錄|缺陷紀錄|abnormal|defect)/.test(normalizedFile) ? 4 : 0;
    const normalizedColumns = columns.map(normalizeName);
    productionScore += normalizedColumns.filter((column) => FIELD_HINTS.parameter.some((hint) => column.includes(hint))).length;
    abnormalScore += normalizedColumns.filter((column) => FIELD_HINTS.abnormal.some((hint) => column.includes(hint))).length;
    const topScore = Math.max(productionScore, abnormalScore);
    const value = topScore === 0 || productionScore === abnormalScore
      ? "unknown"
      : productionScore > abnormalScore ? "production_parameters" : "abnormal_records";
    return {
      value,
      source: "automatic",
      confidence: topScore ? Math.min(0.95, 0.55 + Math.abs(productionScore - abnormalScore) * 0.1) : 0,
      reasons: [`生產參數特徵 ${productionScore}`, `異常紀錄特徵 ${abnormalScore}`],
    };
  }

  function percentile(sorted, p) {
    if (!sorted.length) return null;
    const index = (sorted.length - 1) * p;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    if (lower === upper) return sorted[lower];
    return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
  }

  function numericStats(values) {
    if (!values.length) return null;
    let mean = 0;
    let m2 = 0;
    let min = Infinity;
    let max = -Infinity;
    values.forEach((value, index) => {
      const delta = value - mean;
      mean += delta / (index + 1);
      m2 += delta * (value - mean);
      min = Math.min(min, value);
      max = Math.max(max, value);
    });
    const sorted = [...values].sort((a, b) => a - b);
    const q1 = percentile(sorted, 0.25);
    const median = percentile(sorted, 0.5);
    const q3 = percentile(sorted, 0.75);
    const iqr = q3 - q1;
    const lower = q1 - 1.5 * iqr;
    const upper = q3 + 1.5 * iqr;
    return {
      count: values.length,
      min,
      max,
      mean,
      median,
      std_dev: values.length > 1 ? Math.sqrt(m2 / (values.length - 1)) : 0,
      q1,
      q3,
      outlier_count: values.filter((value) => value < lower || value > upper).length,
    };
  }

  function uniqueColumns(rows) {
    const columns = [];
    const seen = new Set();
    rows.forEach((row) => {
      Object.keys(row || {}).forEach((column) => {
        if (!seen.has(column)) {
          seen.add(column);
          columns.push(column);
        }
      });
    });
    return columns;
  }

  function summarizeColumns(rows, columns) {
    return columns.map((name) => {
      let missing = 0;
      const numbers = [];
      const unique = new Set();
      rows.forEach((row) => {
        const value = row?.[name];
        if (isBlank(value)) {
          missing += 1;
          return;
        }
        if (unique.size < 1000) unique.add(String(value));
        const number = asNumber(value);
        if (number !== null) numbers.push(number);
      });
      const present = rows.length - missing;
      const numericRatio = present ? numbers.length / present : 0;
      return {
        name,
        type: present && numericRatio >= 0.7 ? "numeric" : "text",
        missing_count: missing,
        missing_rate: rows.length ? missing / rows.length : 0,
        unique_count: unique.size,
        stats: present && numericRatio >= 0.7 ? numericStats(numbers) : null,
      };
    });
  }

  function calculateYield(rows, columns) {
    const goodColumn = findColumn(columns, "good");
    const totalColumn = findColumn(columns, "total");
    if (goodColumn && totalColumn) {
      let good = 0;
      let total = 0;
      rows.forEach((row) => {
        const goodValue = asNumber(row?.[goodColumn]);
        const totalValue = asNumber(row?.[totalColumn]);
        if (goodValue !== null && totalValue !== null && totalValue > 0) {
          good += goodValue;
          total += totalValue;
        }
      });
      if (total > 0) return { value: (good / total) * 100, method: `${goodColumn} ÷ ${totalColumn}` };
    }

    const yieldColumn = findColumn(columns, "yield");
    if (!yieldColumn) return null;
    const values = rows.map((row) => asNumber(row?.[yieldColumn])).filter((value) => value !== null);
    if (!values.length) return null;
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    return { value: average <= 1.2 ? average * 100 : average, method: `${yieldColumn} 平均` };
  }

  function lineBreakdown(rows, columns) {
    const lineColumn = findColumn(columns, "line");
    if (!lineColumn) return [];
    const groups = new Map();
    rows.forEach((row) => {
      const raw = row?.[lineColumn];
      if (isBlank(raw)) return;
      const line = String(raw).trim();
      if (!groups.has(line)) groups.set(line, []);
      groups.get(line).push(row);
    });
    return [...groups.entries()]
      .map(([line, lineRows]) => ({
        line,
        row_count: lineRows.length,
        yield: calculateYield(lineRows, columns),
      }))
      .sort((a, b) => b.row_count - a.row_count)
      .slice(0, 30);
  }

  function defectBreakdown(rows, columns) {
    const defectColumn = findColumn(columns, "defect");
    if (!defectColumn) return [];
    const counts = new Map();
    rows.forEach((row) => {
      const raw = row?.[defectColumn];
      if (isBlank(raw)) return;
      const value = String(raw).trim();
      counts.set(value, (counts.get(value) || 0) + 1);
    });
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([label, count]) => ({ label, count, share: total ? count / total : 0 }));
  }

  function analyzeWorkbook(workbook, options) {
    const maxRowsPerSheet = options?.maxRowsPerSheet || DEFAULT_MAX_ROWS_PER_SHEET;
    if (!workbook || !Array.isArray(workbook.sheets) || !workbook.sheets.length) {
      throw new Error("找不到可分析的工作表。");
    }

    let totalRows = 0;
    let analyzedRows = 0;
    let totalMissing = 0;
    let totalCells = 0;
    const allRows = [];
    const allColumns = [];
    const seenColumns = new Set();
    const sheets = workbook.sheets.map((sheet, sheetIndex) => {
      const sourceRows = Array.isArray(sheet.rows) ? sheet.rows : [];
      const rows = sourceRows.slice(0, maxRowsPerSheet);
      const columns = uniqueColumns(rows);
      const columnSummaries = summarizeColumns(rows, columns);
      totalRows += sourceRows.length;
      analyzedRows += rows.length;
      allRows.push(...rows);
      columns.forEach((column) => {
        if (!seenColumns.has(column)) {
          seenColumns.add(column);
          allColumns.push(column);
        }
      });
      columnSummaries.forEach((column) => {
        totalMissing += column.missing_count;
        totalCells += rows.length;
      });
      return {
        name: sheet.name || `Sheet ${sheetIndex + 1}`,
        row_count: sourceRows.length,
        analyzed_row_count: rows.length,
        column_count: columns.length,
        columns: columnSummaries,
      };
    });

    const combinedColumns = summarizeColumns(allRows, allColumns);
    const classification = detectDataType(workbook.fileName, allColumns, options?.dataType);
    const yieldMetric = calculateYield(allRows, allColumns);
    const lines = lineBreakdown(allRows, allColumns);
    return {
      template_id: classification.value === "production_parameters"
        ? "fuye-production-parameters-v1"
        : classification.value === "abnormal_records" ? "fuye-abnormal-records-v1" : "fuye-production-quality-v1",
      data_type: classification.value,
      classification,
      generated_at: new Date().toISOString(),
      input_summary: {
        file_name: workbook.fileName || null,
        sheet_count: sheets.length,
        row_count: totalRows,
        analyzed_row_count: analyzedRows,
        column_count: allColumns.length,
        sampled: analyzedRows < totalRows,
        max_rows_per_sheet: maxRowsPerSheet,
      },
      data_quality: {
        missing_cell_count: totalMissing,
        missing_rate: totalCells ? totalMissing / totalCells : 0,
        numeric_column_count: combinedColumns.filter((column) => column.type === "numeric").length,
        columns: combinedColumns,
        sheets,
      },
      kpis: {
        overall_yield: yieldMetric,
        detected_line_count: lines.length,
      },
      lines,
      defects: defectBreakdown(allRows, allColumns),
      findings: [],
      recommendations: [],
      limitations: [
        "EDA 僅依欄名與資料型態自動辨識；正式製程結論仍需工程人員確認欄位定義與單位。",
        ...(analyzedRows < totalRows ? [`每張工作表最多分析 ${maxRowsPerSheet.toLocaleString()} 筆，結果屬抽樣摘要。`] : []),
      ],
    };
  }

  return { analyzeWorkbook, asNumber, normalizeName, detectDataType };
})();

if (typeof module === "object" && module.exports) module.exports = LineSightEDA;
