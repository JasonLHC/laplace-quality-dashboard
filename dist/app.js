const API_BASE = window.LAPLACE_API_BASE || "";

const fileInput = document.querySelector("#fileInput");
const dropZone = document.querySelector("#dropZone");
const analyzeButton = document.querySelector("#analyzeButton");
const fileTitle = document.querySelector("#fileTitle");
const fileMeta = document.querySelector("#fileMeta");
const jobProgress = document.querySelector("#jobProgress");
const progressLabel = document.querySelector("#progressLabel");
const progressDetail = document.querySelector("#progressDetail");
const progressPercent = document.querySelector("#progressPercent");
const progressBar = document.querySelector("#progressBar");
const toast = document.querySelector("#toast");
const connectionText = document.querySelector("#connectionText");

let selectedFile = null;

if (API_BASE) connectionText.textContent = "API 已設定";

function formatBytes(bytes) {
  if (!bytes) return "0 KB";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.setTimeout(() => toast.classList.remove("show"), 3200);
}

function setFile(file) {
  if (!file) return;
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (!["xlsx", "xls", "csv"].includes(extension)) {
    showToast("請選擇 XLSX、XLS 或 CSV 檔案。");
    return;
  }
  if (file.size > 100 * 1024 * 1024) {
    showToast("檔案超過 100 MB，請縮小後再試。");
    return;
  }
  selectedFile = file;
  fileTitle.textContent = file.name;
  fileMeta.textContent = `${formatBytes(file.size)} · 等待分析`;
  analyzeButton.disabled = false;
}

dropZone.addEventListener("click", (event) => {
  if (event.target !== analyzeButton) fileInput.click();
});
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    fileInput.click();
  }
});
fileInput.addEventListener("change", () => setFile(fileInput.files?.[0]));

["dragenter", "dragover"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragover");
  });
});
["dragleave", "drop"].forEach((eventName) => {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragover");
  });
});
dropZone.addEventListener("drop", (event) => setFile(event.dataTransfer?.files?.[0]));

const demoSteps = [
  [12, "正在驗證資料格式", "檢查工作表、欄位與時間格式"],
  [31, "正在辨識產線", "已找到 4 條產線與 128,450 筆有效資料"],
  [54, "正在計算品質指標", "計算良率、異常分布與製程趨勢"],
  [76, "Laplace AI 分析中", "比較各產線差異並整理改善方向"],
  [92, "正在整理報告", "建立圖表資料與可追溯的建議項目"],
  [100, "分析完成", "品質儀表板已更新"],
];

function updateProgress([percent, label, detail]) {
  progressLabel.textContent = label;
  progressDetail.textContent = detail;
  progressPercent.textContent = `${percent}%`;
  progressBar.style.width = `${percent}%`;
}

async function runDemoAnalysis() {
  jobProgress.hidden = false;
  analyzeButton.disabled = true;
  for (const step of demoSteps) {
    updateProgress(step);
    await new Promise((resolve) => window.setTimeout(resolve, 520));
  }
  fileMeta.textContent = `${formatBytes(selectedFile.size)} · 分析完成`;
  analyzeButton.textContent = "重新分析";
  analyzeButton.disabled = false;
  document.querySelector("#lastUpdated").textContent = new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit" }).format(new Date());
  showToast("示範分析完成。正式串接後將顯示 Laplace AI 的實際結果。");
  document.querySelector("#overview").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function submitToApi() {
  const body = new FormData();
  body.append("file", selectedFile);
  body.append("analysis_type", "production_quality");
  const response = await fetch(`${API_BASE}/api/analysis-jobs`, { method: "POST", body });
  if (!response.ok) throw new Error(`建立分析任務失敗（${response.status}）`);
  const job = await response.json();
  showToast(`分析任務已建立：${job.job_id || job.id}`);
}

analyzeButton.addEventListener("click", async (event) => {
  event.stopPropagation();
  if (!selectedFile) return;
  try {
    if (API_BASE) await submitToApi();
    else await runDemoAnalysis();
  } catch (error) {
    analyzeButton.disabled = false;
    showToast(error instanceof Error ? error.message : "分析任務建立失敗，請稍後再試。");
  }
});

document.querySelector("#refreshButton").addEventListener("click", () => {
  document.querySelector("#lastUpdated").textContent = new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit" }).format(new Date());
  showToast("儀表板已重新整理。");
});

document.querySelectorAll(".filter").forEach((button) => {
  button.addEventListener("click", () => {
    button.parentElement.querySelectorAll(".filter").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    showToast(`已切換為「${button.textContent}」檢視。`);
  });
});
