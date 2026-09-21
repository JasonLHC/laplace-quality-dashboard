const config = window.LINESIGHT_CONFIG || {};
const XLSX_LIB = typeof XLSX !== "undefined" ? XLSX : window.XLSX;
const API_BASE = String(config.apiBaseUrl || window.LAPLACE_API_BASE || "").replace(/\/$/, "");
const MAX_FILE_BYTES = 50 * 1024 * 1024;

const elements = {
  fileInput: document.querySelector("#fileInput"),
  analysisType: document.querySelector("#analysisType"),
  dropZone: document.querySelector("#dropZone"),
  analyzeButton: document.querySelector("#analyzeButton"),
  fileTitle: document.querySelector("#fileTitle"),
  fileMeta: document.querySelector("#fileMeta"),
  jobProgress: document.querySelector("#jobProgress"),
  progressLabel: document.querySelector("#progressLabel"),
  progressDetail: document.querySelector("#progressDetail"),
  progressPercent: document.querySelector("#progressPercent"),
  progressBar: document.querySelector("#progressBar"),
  toast: document.querySelector("#toast"),
  connectionText: document.querySelector("#connectionText"),
};

let selectedFile = null;
let latestEda = null;

elements.connectionText.textContent = API_BASE ? "Agent API 已設定" : "本機 EDA 模式";
elements.fileMeta.textContent = "支援 XLSX、XLS、CSV，單檔上限 50 MB";

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatNumber(value, digits = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("zh-TW", { maximumFractionDigits: digits }).format(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  window.setTimeout(() => elements.toast.classList.remove("show"), 4200);
}

function updateProgress(percent, label, detail) {
  elements.jobProgress.hidden = false;
  elements.progressLabel.textContent = label;
  elements.progressDetail.textContent = detail;
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressBar.style.width = `${percent}%`;
}

function setFile(file) {
  if (!file) return;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["xlsx", "xls", "csv"].includes(extension)) {
    showToast("請選擇 XLSX、XLS 或 CSV 檔案。");
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    showToast("檔案超過 50 MB；為維持瀏覽器穩定度，請先拆分檔案。");
    return;
  }
  selectedFile = file;
  latestEda = null;
  elements.fileTitle.textContent = file.name;
  elements.fileMeta.textContent = `${formatBytes(file.size)} · 等待本機資料健檢`;
  elements.analyzeButton.textContent = "開始分析";
  elements.analyzeButton.disabled = false;
}

elements.dropZone.addEventListener("click", (event) => {
  if (event.target !== elements.analyzeButton) elements.fileInput.click();
});
elements.dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    elements.fileInput.click();
  }
});
elements.fileInput.addEventListener("change", () => setFile(elements.fileInput.files?.[0]));

["dragenter", "dragover"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  elements.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.dropZone.classList.remove("dragover");
  });
});
elements.dropZone.addEventListener("drop", (event) => setFile(event.dataTransfer?.files?.[0]));

async function readWorkbook(file) {
  if (!XLSX_LIB) throw new Error("Excel 解析模組載入失敗，請重新整理頁面。");
  const isCsv = file.name.toLowerCase().endsWith(".csv");
  const source = isCsv ? await file.text() : await file.arrayBuffer();
  const workbook = XLSX_LIB.read(source, { type: isCsv ? "string" : "array", cellDates: true, raw: true });
  const sheets = workbook.SheetNames.map((name) => ({
    name,
    rows: XLSX_LIB.utils.sheet_to_json(workbook.Sheets[name], {
      defval: null,
      raw: true,
      blankrows: false,
    }),
  })).filter((sheet) => sheet.rows.length);
  return { fileName: file.name, sheets };
}

function renderMetrics(report) {
  const yieldMetric = report.kpis.overall_yield;
  const isAbnormal = report.data_type === "abnormal_records";
  const countFallback = report.input_summary.row_count;
  document.querySelector("#primaryMetricLabel").textContent = isAbnormal
    ? "異常紀錄"
    : yieldMetric ? "整體良率" : "製程紀錄";
  document.querySelector("#overallYield").innerHTML = yieldMetric && !isAbnormal
    ? `${formatNumber(yieldMetric.value, 2)}<small>%</small>`
    : formatNumber(countFallback, 0);
  document.querySelector("#primaryMetricStatus").textContent = report.classification.source === "manual" ? "手動指定" : "自動判別";

  const lineCount = report.kpis.detected_line_count;
  document.querySelector("#lineCount").textContent = String(lineCount).padStart(2, "0");
  document.querySelector("#lineCountChip").textContent = lineCount ? `${lineCount} 條` : "未辨識";
  document.querySelector("#lineNames").textContent = lineCount
    ? report.lines.slice(0, 6).map((line) => line.line).join("、")
    : "需要產線／線別欄位";

  const numericCount = report.data_quality.numeric_column_count;
  document.querySelector("#numericColumnCount").textContent = formatNumber(numericCount, 0);
  document.querySelector("#numericStatus").textContent = "本機 EDA";
  document.querySelector("#numericColumnNote").textContent = `共 ${formatNumber(report.input_summary.column_count, 0)} 個欄位`;

  document.querySelector("#rowCount").innerHTML = formatNumber(report.input_summary.row_count, 0);
  document.querySelector("#dataStatus").textContent = report.input_summary.sampled ? "抽樣" : "完整";
  document.querySelector("#coverageNote").textContent = `資料涵蓋率 ${formatNumber((1 - report.data_quality.missing_rate) * 100, 1)}%`;
}

function renderAudit(report) {
  const typeLabel = report.data_type === "production_parameters"
    ? "生產參數"
    : report.data_type === "abnormal_records" ? "異常紀錄" : "待確認類型";
  document.querySelector("#edaMode").textContent = `${typeLabel} · 本機完成`;
  document.querySelector("#auditSummary").innerHTML = `
    <div class="audit-facts">
      <div><b>${formatNumber(report.input_summary.sheet_count, 0)}</b><span>工作表</span></div>
      <div><b>${formatNumber(report.input_summary.row_count, 0)}</b><span>資料列</span></div>
      <div><b>${formatNumber(report.input_summary.column_count, 0)}</b><span>欄位</span></div>
      <div><b>${formatNumber(report.data_quality.missing_rate * 100, 1)}%</b><span>缺失率</span></div>
    </div>
    <p>${escapeHtml(report.limitations.join(" "))}</p>`;

  const columns = [...report.data_quality.columns]
    .sort((a, b) => (a.type === b.type ? b.missing_rate - a.missing_rate : a.type === "numeric" ? -1 : 1))
    .slice(0, 20);
  document.querySelector("#auditTableBody").innerHTML = columns.map((column) => `
    <tr>
      <td><strong>${escapeHtml(column.name)}</strong></td>
      <td>${column.type === "numeric" ? "數值" : "文字"}</td>
      <td>${formatNumber(column.missing_rate * 100, 1)}%</td>
      <td>${column.stats ? formatNumber(column.stats.mean, 2) : "—"}</td>
      <td>${column.stats ? formatNumber(column.stats.std_dev, 2) : "—"}</td>
      <td>${column.stats ? formatNumber(column.stats.outlier_count, 0) : "—"}</td>
    </tr>`).join("");
  document.querySelector("#auditTableWrap").hidden = false;
}

function renderPrimaryChart(report) {
  const withYield = report.lines.filter((line) => line.yield && Number.isFinite(line.yield.value));
  const source = withYield.length
    ? withYield.slice(0, 12).map((line) => ({ label: line.line, value: line.yield.value, suffix: "%" }))
    : report.data_quality.sheets.slice(0, 12).map((sheet) => ({ label: sheet.name, value: sheet.row_count, suffix: " 筆" }));
  document.querySelector("#primaryChartTitle").textContent = withYield.length ? "各產線良率比較" : "各工作表資料量";
  document.querySelector(".legend").hidden = true;
  if (!source.length) {
    document.querySelector("#primaryChart").innerHTML = '<p class="empty-state">沒有可繪製的資料。</p>';
    return;
  }
  const max = Math.max(...source.map((item) => item.value), 1);
  document.querySelector("#primaryChart").innerHTML = `<div class="quality-bars">${source.map((item) => `
    <div class="quality-bar"><span>${escapeHtml(item.label)}</span><div><i style="width:${Math.max(2, (item.value / max) * 100)}%"></i></div><b>${formatNumber(item.value, 2)}${item.suffix}</b></div>
  `).join("")}</div>`;
}

function renderDefects(report) {
  const container = document.querySelector("#defectChart");
  if (!report.defects.length) {
    container.innerHTML = '<p class="empty-state">未辨識到「不良原因／缺陷類型」欄位。</p>';
    return;
  }
  const maxShare = Math.max(...report.defects.map((item) => item.share), 0.01);
  container.innerHTML = report.defects.map((item) => `
    <div class="pareto-row"><span title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span><div><i style="width:${(item.share / maxShare) * 100}%"></i></div><b>${formatNumber(item.share * 100, 1)}%</b></div>
  `).join("");
}

function renderLines(report) {
  const body = document.querySelector("#lineTableBody");
  if (!report.lines.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty-state">未辨識到產線欄位；請在 Excel 使用「產線、線別或 Line」等欄名。</td></tr>';
    return;
  }
  body.innerHTML = report.lines.slice(0, 20).map((line) => {
    const yieldValue = line.yield?.value;
    return `<tr>
      <td><strong>${escapeHtml(line.line)}</strong></td>
      <td>${yieldValue === undefined ? "—" : `${formatNumber(yieldValue, 2)}%`}</td>
      <td>${formatNumber(line.row_count, 0)} 筆</td>
      <td>—</td>
      <td><span class="status ${yieldValue === undefined ? "watch" : "stable"}">${yieldValue === undefined ? "待確認" : "已辨識"}</span></td>
    </tr>`;
  }).join("");
}

function renderAgentWaiting(report) {
  document.querySelector("#aiStatus").innerHTML = `<i></i>${API_BASE ? "等待 Agent" : "尚未連線"}`;
  document.querySelector(".insight-summary").innerHTML = `
    <span class="priority high">EDA</span>
    <div><strong>本機資料健檢已完成</strong><p>${API_BASE ? "原始檔案保留在瀏覽器；Cloudflare 僅將 EDA 統計摘要送至 Laplace Agent 團隊。" : "設定 Cloudflare Worker 位址後，才能取得根因分析與改善建議。"}</p></div>`;
  document.querySelector(".action-list").innerHTML = `
    <li><span>01</span><div><strong>確認欄位與單位</strong><p>目前辨識 ${report.input_summary.column_count} 個欄位、${report.input_summary.row_count} 筆資料。</p></div></li>
    <li><span>02</span><div><strong>交由 Agent 深度分析</strong><p>產線根因、證據強度與改善建議不由簡單 EDA 自動推定。</p></div></li>`;
}

function renderReport(report) {
  renderMetrics(report);
  renderAudit(report);
  renderPrimaryChart(report);
  renderDefects(report);
  renderLines(report);
  renderAgentWaiting(report);
  document.querySelector("#lastUpdated").textContent = new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit" }).format(new Date());
}

async function runLocalEda(file) {
  updateProgress(8, "正在讀取 Excel", "檔案只在目前瀏覽器中解析，不會上傳到 GitHub");
  await new Promise((resolve) => window.setTimeout(resolve, 30));
  const workbook = await readWorkbook(file);
  updateProgress(35, "正在進行資料健檢", "辨識工作表、欄位型態、缺失值與數值分布");
  await new Promise((resolve) => window.setTimeout(resolve, 30));
  const edaModule = typeof LineSightEDA !== "undefined" ? LineSightEDA : window.LineSightEDA;
  if (!edaModule) throw new Error("EDA 分析模組載入失敗，請重新整理頁面。");
  const report = edaModule.analyzeWorkbook(workbook, { dataType: elements.analysisType.value });
  renderReport(report);
  latestEda = report;
  return report;
}

async function submitToApi(report) {
  updateProgress(62, "正在送出 EDA 摘要", "原始 Excel 留在瀏覽器；Cloudflare 僅轉送統計摘要");
  const response = await fetch(`${API_BASE}/api/analysis-jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      analysis_type: report.data_type,
      template_id: report.template_id,
      eda_summary: report,
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `建立分析任務失敗（${response.status}）`);
  updateProgress(100, "Agent 任務已建立", payload.message || "Laplace Agent 團隊已收到分析資料");
  document.querySelector("#aiStatus").innerHTML = "<i></i>Agent 已接收";
  return payload;
}

elements.analyzeButton.addEventListener("click", async (event) => {
  event.stopPropagation();
  if (!selectedFile) return;
  elements.analyzeButton.disabled = true;
  try {
    const report = await runLocalEda(selectedFile);
    if (API_BASE) {
      const job = await submitToApi(report);
      showToast(`分析任務已建立${job.job_id ? `：${job.job_id}` : ""}`);
      elements.fileMeta.textContent = `${formatBytes(selectedFile.size)} · 原始檔未上傳 · EDA 摘要已送交 Agent`;
    } else {
      updateProgress(100, "本機 EDA 完成", "Cloudflare Worker 尚未設定，因此未上傳檔案");
      showToast("本機 EDA 已完成；目前未設定 Agent API，因此檔案沒有離開瀏覽器。");
      elements.fileMeta.textContent = `${formatBytes(selectedFile.size)} · 本機 EDA 完成`;
    }
    elements.analyzeButton.textContent = "重新分析";
    document.querySelector("#overview").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    updateProgress(0, "分析失敗", error instanceof Error ? error.message : "無法完成分析");
    showToast(error instanceof Error ? error.message : "分析失敗，請檢查檔案後再試。");
  } finally {
    elements.analyzeButton.disabled = false;
  }
});

document.querySelector("#refreshButton").addEventListener("click", () => {
  if (latestEda) renderReport(latestEda);
  showToast(latestEda ? "已重新呈現目前的 EDA 結果。" : "請先匯入 Excel 或 CSV。");
});

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    button.parentElement.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    showToast("時間與產線篩選將在 Agent 回傳標準報告後啟用。");
  });
});
