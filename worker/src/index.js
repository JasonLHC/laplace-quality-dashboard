const DEFAULT_ORIGIN = "https://jasonlhc.github.io";
const MAX_FILE_BYTES = 50 * 1024 * 1024;

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
  const required = ["LAPLACE_BASE_URL", "LAPLACE_ENDPOINT_SECRET", "LAPLACE_UPLOAD_PATH", "LAPLACE_INVOKE_PATH"];
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

function extractFileId(payload) {
  return (
    payload.uploadFileId ||
    payload.fileId ||
    payload.id ||
    payload.data?.uploadFileId ||
    payload.data?.fileId ||
    payload.data?.id ||
    null
  );
}

function extractJobId(payload) {
  return payload.job_id || payload.jobId || payload.run_id || payload.runId || payload.id || payload.data?.id || null;
}

function compactEda(formData) {
  const raw = formData.get("eda_summary");
  if (typeof raw !== "string" || !raw) return null;
  try {
    const report = JSON.parse(raw);
    return {
      template_id: report.template_id,
      data_type: report.data_type,
      classification: report.classification,
      input_summary: report.input_summary,
      data_quality: {
        missing_rate: report.data_quality?.missing_rate,
        numeric_column_count: report.data_quality?.numeric_column_count,
      },
      kpis: report.kpis,
      detected_lines: report.lines?.map((line) => line.line).slice(0, 30),
    };
  } catch {
    return null;
  }
}

function analysisMessage(templateId, dataType, eda) {
  const focus = dataType === "production_parameters"
    ? "這是生產參數資料。分析參數分布、跨產線／批次差異、漂移、離群值與品質關聯；不得把相關性寫成已證實因果。"
    : dataType === "abnormal_records"
      ? "這是異常紀錄。分析異常類型 Pareto、發生頻率、時間／產線／批次集中度、重複事件、處置結果與根因候選。"
      : "資料類型尚未確定。先依檔名、欄位與內容判別是生產參數或異常紀錄；若證據不足，明確標示待確認。";
  return [
    `請分析附件中的製程 Excel，並依 ${templateId || "fuye-production-quality-v1"} 模板輸出。`,
    focus,
    "必須區分 observed、correlated、hypothesis、validated；每項結論附資料來源、信心程度、驗證方法與限制。",
    "請涵蓋資料健檢、多產線 KPI、異常、根因候選、改善優先順序及預期 KPI。",
    eda ? `前端本機 EDA 摘要（僅供定位，仍須由原始附件驗證）：${JSON.stringify(eda)}` : "",
  ].filter(Boolean).join("\n");
}

async function createAnalysisJob(request, env) {
  requireConfiguration(env);
  const formData = await request.formData();
  const file = formData.get("file");
  if (!(file instanceof File) || !file.name) return json({ error: "缺少 Excel 或 CSV 檔案。" }, 400);
  if (file.size > MAX_FILE_BYTES) return json({ error: "檔案超過 50 MB。" }, 413);
  if (!/\.(xlsx|xls|csv)$/i.test(file.name)) return json({ error: "僅支援 XLSX、XLS、CSV。" }, 415);

  const upstreamForm = new FormData();
  upstreamForm.append("fileName", file.name);
  upstreamForm.append("fileToUpload", file, file.name);
  const uploadResponse = await fetch(new URL(env.LAPLACE_UPLOAD_PATH, env.LAPLACE_BASE_URL), {
    method: "POST",
    headers: { authorization: `Bearer ${env.LAPLACE_ENDPOINT_SECRET}` },
    body: upstreamForm,
  });
  const uploadPayload = await upstreamJson(uploadResponse, "Laplace 檔案上傳");
  const fileId = extractFileId(uploadPayload);
  if (!fileId) throw new Error("Laplace 上傳成功，但回應中找不到 uploadFileId／fileId。");

  const templateId = String(formData.get("template_id") || "fuye-production-quality-v1");
  const dataType = String(formData.get("analysis_type") || "unknown");
  const invokeBody = {
    message: analysisMessage(templateId, dataType, compactEda(formData)),
    attachments: [{ fileId }],
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
    upload_file_id: fileId,
    message: "Laplace Agent 團隊已收到檔案。",
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
      return json({ error: error instanceof Error ? error.message : "Unexpected error" }, 502, cors);
    }
  },
};
