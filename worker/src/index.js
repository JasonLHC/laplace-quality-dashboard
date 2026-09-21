const DEFAULT_ORIGIN = "https://jasonlhc.github.io";
const MAX_REQUEST_BYTES = 1024 * 1024;
const SUPPORTED_DATA_TYPES = new Set(["production_parameters", "abnormal_records", "unknown"]);

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

async function upstreamJson(response, operation) {
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`${operation}回傳非 JSON 內容（HTTP ${response.status}）`);
  }
  if (!response.ok) {
    const detail = payload.message || payload.error || `HTTP ${response.status}`;
    throw new Error(`${operation}失敗：${detail}`);
  }
  return payload;
}

function extractJobId(payload) {
  return payload.job_id || payload.jobId || payload.run_id || payload.runId || payload.id || payload.data?.id || null;
}

async function parseRequestJson(request) {
  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_REQUEST_BYTES) throw new Response(JSON.stringify({ error: "EDA 摘要超過 1 MB。" }), { status: 413 });
  const raw = await request.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) {
    throw new Response(JSON.stringify({ error: "EDA 摘要超過 1 MB。" }), { status: 413 });
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Response(JSON.stringify({ error: "請求內容不是有效 JSON。" }), { status: 400 });
  }
}

function compactEda(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) return null;
  const dataType = String(report.data_type || "unknown");
  if (!SUPPORTED_DATA_TYPES.has(dataType)) return null;
  if (!report.input_summary || !report.data_quality || !report.kpis) return null;
  return {
    template_id: String(report.template_id || "fuye-production-quality-v1").slice(0, 100),
    data_type: dataType,
    classification: report.classification,
    generated_at: report.generated_at,
    input_summary: report.input_summary,
    data_quality: {
      missing_cell_count: report.data_quality.missing_cell_count,
      missing_rate: report.data_quality.missing_rate,
      numeric_column_count: report.data_quality.numeric_column_count,
      columns: Array.isArray(report.data_quality.columns) ? report.data_quality.columns.slice(0, 150) : [],
      sheets: Array.isArray(report.data_quality.sheets) ? report.data_quality.sheets.slice(0, 30) : [],
    },
    kpis: report.kpis,
    lines: Array.isArray(report.lines) ? report.lines.slice(0, 30) : [],
    defects: Array.isArray(report.defects) ? report.defects.slice(0, 20) : [],
    limitations: Array.isArray(report.limitations) ? report.limitations.slice(0, 20) : [],
  };
}

function analysisMessage(templateId, dataType, eda) {
  const focus = dataType === "production_parameters"
    ? "這是生產參數資料。分析參數分布、跨產線／批次差異、漂移、離群值與品質關聯；不得把相關性寫成已證實因果。"
    : dataType === "abnormal_records"
      ? "這是異常紀錄。分析異常類型 Pareto、發生頻率、時間／產線／批次集中度、重複事件、處置結果與根因候選。"
      : "資料類型尚未確定。先依檔名、欄位與內容判別是生產參數或異常紀錄；若證據不足，明確標示待確認。";
  return [
    `請分析下方由使用者瀏覽器計算的 Excel EDA JSON，並依 ${templateId || "fuye-production-quality-v1"} 模板輸出。`,
    focus,
    "你無法取得原始 Excel 或逐列資料，不得聲稱已讀取附件；超出摘要證據的內容必須標示為待驗證或資料限制。",
    "必須區分 observed、correlated、hypothesis、validated；每項結論附資料來源、信心程度、驗證方法與限制。",
    "請涵蓋資料健檢、多產線 KPI、異常、根因候選、改善優先順序及預期 KPI。",
    `前端本機 EDA 摘要：${JSON.stringify(eda)}`,
  ].filter(Boolean).join("\n");
}

async function createAnalysisJob(request, env) {
  requireConfiguration(env);
  const payload = await parseRequestJson(request);
  const eda = compactEda(payload.eda_summary);
  if (!eda) return json({ error: "缺少有效的 eda_summary。" }, 400);
  const templateId = String(payload.template_id || eda.template_id || "fuye-production-quality-v1").slice(0, 100);
  const dataType = SUPPORTED_DATA_TYPES.has(payload.analysis_type) ? payload.analysis_type : eda.data_type;
  const invokeBody = {
    message: analysisMessage(templateId, dataType, eda),
  };
  if (env.PUBLIC_WORKER_URL && env.ANALYSIS_RESULTS && env.LAPLACE_WEBHOOK_SECRET) {
    invokeBody.webhookUrl = `${String(env.PUBLIC_WORKER_URL).replace(/\/$/, "")}/api/webhooks/laplace`;
  }

  const invokeResponse = await fetch(new URL(env.LAPLACE_INVOKE_PATH, env.LAPLACE_BASE_URL), {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.LAPLACE_ENDPOINT_SECRET}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(invokeBody),
  });
  const invokePayload = await upstreamJson(invokeResponse, "Laplace Agent 呼叫");
  return json({
    status: invokeResponse.status === 202 ? "accepted" : "completed",
    job_id: extractJobId(invokePayload),
    message: "Laplace Agent 團隊已收到 EDA 摘要；原始檔案未上傳。",
    result: invokePayload,
  }, invokeResponse.status === 202 ? 202 : 200);
}

function hex(bytes) {
  return [...new Uint8Array(bytes)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

function safeEqual(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function verifyWebhook(request, secret, rawBody) {
  const signature = request.headers.get("x-signature") || "";
  const timestamp = request.headers.get("x-timestamp") || "";
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds) || Math.abs(Date.now() / 1000 - seconds) > 300) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${rawBody}`));
  return safeEqual(signature, `sha256=${hex(digest)}`);
}

async function receiveWebhook(request, env) {
  if (!env.LAPLACE_WEBHOOK_SECRET) return json({ error: "Webhook secret 尚未設定。" }, 503);
  const rawBody = await request.text();
  if (!(await verifyWebhook(request, env.LAPLACE_WEBHOOK_SECRET, rawBody))) return json({ error: "Webhook 簽章無效。" }, 401);
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Webhook 內容不是有效 JSON。" }, 400);
  }
  const jobId = extractJobId(payload);
  if (!jobId) return json({ error: "Webhook 缺少任務識別碼。" }, 400);
  if (!env.ANALYSIS_RESULTS) return json({ error: "ANALYSIS_RESULTS KV 尚未綁定。" }, 503);
  await env.ANALYSIS_RESULTS.put(`job:${jobId}`, JSON.stringify(payload), { expirationTtl: 7 * 24 * 60 * 60 });
  return new Response(null, { status: 204 });
}

async function getAnalysisJob(jobId, env) {
  if (!env.ANALYSIS_RESULTS) return json({ error: "ANALYSIS_RESULTS KV 尚未綁定。" }, 503);
  const result = await env.ANALYSIS_RESULTS.get(`job:${jobId}`, "json");
  return result ? json({ status: "completed", job_id: jobId, result }) : json({ status: "pending", job_id: jobId }, 202);
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
        const response = await createAnalysisJob(request, env);
        Object.entries(cors).forEach(([name, value]) => response.headers.set(name, value));
        return response;
      }
      if (request.method === "POST" && url.pathname === "/api/webhooks/laplace") return receiveWebhook(request, env);
      const match = url.pathname.match(/^\/api\/analysis-jobs\/([^/]+)$/);
      if (request.method === "GET" && match) {
        const response = await getAnalysisJob(decodeURIComponent(match[1]), env);
        Object.entries(cors).forEach(([name, value]) => response.headers.set(name, value));
        return response;
      }
      return json({ error: "Not found" }, 404, cors);
    } catch (error) {
      if (error instanceof Response) {
        Object.entries(cors).forEach(([name, value]) => error.headers.set(name, value));
        if (!error.headers.has("content-type")) error.headers.set("content-type", "application/json; charset=utf-8");
        return error;
      }
      return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 502, cors);
    }
  },
};
