const DEFAULT_ORIGIN = "https://jasonlhc.github.io";
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 2;
const SUPPORTED_EXTENSIONS = new Set(["xlsx", "xls", "csv"]);

function json(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function allowedOrigins(env) {
  return new Set(
    String(env.ALLOWED_ORIGINS || DEFAULT_ORIGIN)
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
  );
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const allowed = allowedOrigins(env);
  const local = origin && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
  if (!origin || (!allowed.has(origin) && !local)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

function requireConfiguration(env) {
  const required = ["LAPLACE_BASE_URL", "LAPLACE_ENDPOINT_SECRET", "LAPLACE_INVOKE_PATH"];
  const missing = required.filter((name) => !env[name]);
  if (missing.length) throw new Error(`Worker 尚未設定：${missing.join(", ")}`);
}

class UpstreamError extends Error {
  constructor(operation, status, payload) {
    const detail = payload?.message || payload?.error?.message || payload?.detail || `HTTP ${status}`;
    super(`${operation}失敗：${detail}`);
    this.status = status;
    this.code = payload?.code || payload?.error?.code;
    this.requestId = payload?.requestId || payload?.error?.requestId;
  }
}

async function readUpstream(response, operation) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { message: `回傳非 JSON 內容（HTTP ${response.status}）` };
  }
  if (!response.ok) throw new UpstreamError(operation, response.status, payload);
  return payload;
}

function endpointUrl(env, suffix) {
  const basePath = String(env.LAPLACE_INVOKE_PATH).replace(/\/$/, "");
  return new URL(`${basePath}${suffix}`, env.LAPLACE_BASE_URL);
}

function bearerHeaders(env, extra = {}) {
  return { authorization: `Bearer ${env.LAPLACE_ENDPOINT_SECRET}`, ...extra };
}

function extractJobId(payload) {
  return payload?.data?.jobId || payload?.data?.job_id || payload?.jobId || payload?.job_id || payload?.id || null;
}

function extractFileId(payload) {
  return payload?.data?.fileId || payload?.data?.file_id || payload?.fileId || payload?.file_id || null;
}

function extensionOf(fileName) {
  return String(fileName || "").split(".").pop()?.toLowerCase() || "";
}

function validateFiles(files) {
  if (!files.length) throw new Response(JSON.stringify({ error: "請至少上傳一份 Excel 或 CSV。" }), { status: 400 });
  if (files.length > MAX_FILES) throw new Response(JSON.stringify({ error: `一次最多上傳 ${MAX_FILES} 份檔案。` }), { status: 400 });
  for (const file of files) {
    if (!(file instanceof File) || !SUPPORTED_EXTENSIONS.has(extensionOf(file.name))) {
      throw new Response(JSON.stringify({ error: "僅支援 XLSX、XLS 或 CSV。" }), { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      throw new Response(JSON.stringify({ error: `${file.name} 超過 50 MB。` }), { status: 413 });
    }
  }
}

function parseEdaSummaries(form) {
  const reports = [];
  for (const value of form.getAll("eda_summary")) {
    if (typeof value !== "string" || !value.trim()) continue;
    try {
      reports.push(JSON.parse(value));
    } catch {
      throw new Response(JSON.stringify({ error: "eda_summary 不是有效 JSON。" }), { status: 400 });
    }
  }
  return reports;
}

function analysisMessage(files, reports) {
  const summaries = reports.map((report) => ({
    file_name: report?.input_summary?.file_name,
    data_type: report?.data_type,
    row_count: report?.input_summary?.row_count,
    column_count: report?.input_summary?.column_count,
    missing_rate: report?.data_quality?.missing_rate,
  }));
  return [
    "請現在立即使用 fetch_uploaded_file 工具讀取所有附件並完成分析，不要只描述計畫或下一步。",
    "請輸出資料健檢、欄位與筆數證據、產線或批次品質差異、異常 Pareto、可能根因、可執行改善建議與限制。",
    "每項結論請區分 observed、correlated、hypothesis、validated；不得把相關性寫成已證實因果。",
    `附件：${files.map((file) => file.name).join("、")}`,
    summaries.length ? `瀏覽器 EDA 索引：${JSON.stringify(summaries)}` : "",
  ].filter(Boolean).join("\n");
}

async function uploadFile(file, env) {
  const body = new FormData();
  body.append("fileToUpload", file, file.name);
  const response = await fetch(endpointUrl(env, "/files"), {
    method: "POST",
    headers: bearerHeaders(env),
    body,
  });
  const payload = await readUpstream(response, `Laplace 檔案上傳（${file.name}）`);
  const fileId = extractFileId(payload);
  if (!fileId) throw new UpstreamError("Laplace 檔案上傳", 502, { message: "成功回應缺少 data.fileId" });
  return fileId;
}

async function createAnalysisJob(request, env) {
  requireConfiguration(env);
  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return json({ error: "請使用 multipart/form-data 上傳 Excel 或 CSV。" }, 415);
  }
  const form = await request.formData();
  const files = [...form.getAll("files"), ...form.getAll("file")].filter((value) => value instanceof File);
  validateFiles(files);
  const reports = parseEdaSummaries(form);
  const fileIds = [];
  for (const file of files) fileIds.push(await uploadFile(file, env));

  const response = await fetch(endpointUrl(env, "/jobs"), {
    method: "POST",
    headers: bearerHeaders(env, { "content-type": "application/json" }),
    body: JSON.stringify({
      message: analysisMessage(files, reports),
      locale: "zh-TW",
      attachments: fileIds.map((fileId) => ({ fileId })),
    }),
  });
  const payload = await readUpstream(response, "Laplace 分析任務建立");
  const jobId = extractJobId(payload);
  if (!jobId) throw new UpstreamError("Laplace 分析任務建立", 502, { message: "成功回應缺少 jobId" });
  return json({
    status: payload.status || payload?.data?.status || "queued",
    job_id: jobId,
    message: `${files.length} 份檔案已送交 Laplace 虛擬團隊。`,
    request_id: payload.requestId || payload?.data?.requestId,
  }, response.status === 202 ? 202 : 200);
}

async function getAnalysisJob(jobId, env) {
  requireConfiguration(env);
  const response = await fetch(endpointUrl(env, `/jobs/${encodeURIComponent(jobId)}`), {
    headers: bearerHeaders(env),
  });
  const payload = await readUpstream(response, "Laplace 分析任務查詢");
  const data = payload?.data || payload;
  return json({
    status: data.status,
    job_id: data.jobId || data.job_id || jobId,
    result: data.result,
    request_id: payload.requestId || data.requestId,
  });
}

function withCors(response, cors) {
  Object.entries(cors).forEach(([name, value]) => response.headers.set(name, value));
  return response;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json({ ok: true, laplace_configured: Boolean(env.LAPLACE_ENDPOINT_SECRET) }, 200, cors);
      }
      if (request.method === "POST" && url.pathname === "/api/analysis-jobs") {
        return withCors(await createAnalysisJob(request, env), cors);
      }
      const match = url.pathname.match(/^\/api\/analysis-jobs\/([^/]+)$/);
      if (request.method === "GET" && match) {
        return withCors(await getAnalysisJob(decodeURIComponent(match[1]), env), cors);
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      if (error instanceof Response) {
        if (!error.headers.has("content-type")) error.headers.set("content-type", "application/json; charset=utf-8");
        return withCors(error, cors);
      }
      if (error instanceof UpstreamError) {
        return json({
          error: error.message,
          code: error.code,
          request_id: error.requestId,
          upstream_status: error.status,
        }, error.status, cors);
      }
      return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 502, cors);
    }
  },
};
