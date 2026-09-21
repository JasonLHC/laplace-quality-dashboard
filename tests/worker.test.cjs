const test = require("node:test");
const assert = require("node:assert/strict");

const validReport = {
  template_id: "fuye-production-parameters-v1",
  data_type: "production_parameters",
  classification: { source: "automatic", confidence: 0.9 },
  generated_at: "2026-09-21T00:00:00.000Z",
  input_summary: { file_name: "sample.xlsx", sheet_count: 1, row_count: 2, column_count: 2 },
  data_quality: {
    missing_cell_count: 0,
    missing_rate: 0,
    numeric_column_count: 1,
    columns: [{ name: "電流", type: "numeric", missing_rate: 0, stats: { mean: 10.5 } }],
    sheets: [{ name: "Sheet1", row_count: 2 }],
  },
  kpis: { overall_yield: null, detected_line_count: 1 },
  lines: [{ line: "A12", row_count: 2, yield: null }],
  defects: [],
  limitations: ["摘要限制"],
};

const env = {
  ALLOWED_ORIGINS: "https://jasonlhc.github.io",
  LAPLACE_BASE_URL: "https://www.laplaceai.co",
  LAPLACE_ENDPOINT_SECRET: "test-secret",
  LAPLACE_INVOKE_PATH: "/invoke/test",
};

test("Worker sends EDA JSON in the invoke message without uploading an attachment", async () => {
  const worker = (await import("../worker/src/index.js")).default;
  const originalFetch = global.fetch;
  let upstreamRequest;
  global.fetch = async (input, init) => {
    upstreamRequest = new Request(input, init);
    return new Response(JSON.stringify({ jobId: "job-123" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const request = new Request("https://worker.example/api/analysis-jobs", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://jasonlhc.github.io" },
      body: JSON.stringify({
        analysis_type: validReport.data_type,
        template_id: validReport.template_id,
        eda_summary: validReport,
      }),
    });
    const response = await worker.fetch(request, env);
    const result = await response.json();
    const invokeBody = JSON.parse(await upstreamRequest.text());

    assert.equal(response.status, 200);
    assert.equal(result.job_id, "job-123");
    assert.equal(result.upload_file_id, undefined);
    assert.equal(upstreamRequest.url, "https://www.laplaceai.co/invoke/test");
    assert.equal(upstreamRequest.headers.get("authorization"), "Bearer test-secret");
    assert.equal(invokeBody.attachments, undefined);
    assert.match(invokeBody.message, /原始 Excel/);
    assert.match(invokeBody.message, /production_parameters/);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://jasonlhc.github.io");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Worker rejects requests without a valid EDA summary before invoking Laplace", async () => {
  const worker = (await import("../worker/src/index.js")).default;
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => {
    called = true;
    return new Response("{}");
  };
  try {
    const request = new Request("https://worker.example/api/analysis-jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eda_summary: { data_type: "unsupported" } }),
    });
    const response = await worker.fetch(request, env);
    assert.equal(response.status, 400);
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});
