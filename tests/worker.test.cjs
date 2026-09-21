const test = require("node:test");
const assert = require("node:assert/strict");

const env = {
  ALLOWED_ORIGINS: "https://jasonlhc.github.io",
  LAPLACE_BASE_URL: "https://backend-api.laplaceai.co",
  LAPLACE_ENDPOINT_SECRET: "ep_secret_test",
  LAPLACE_INVOKE_PATH: "/api/v1/invoke/ep_test",
};

const validReport = {
  template_id: "fuye-production-parameters-v1",
  data_type: "production_parameters",
  input_summary: { file_name: "production.csv", row_count: 2, column_count: 2 },
  data_quality: { missing_rate: 0 },
};

test("Worker uploads each file with fileToUpload then creates a team job", async () => {
  const worker = (await import("../worker/src/index.js")).default;
  const originalFetch = global.fetch;
  const requests = [];
  let uploadIndex = 0;
  global.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    if (request.url.endsWith("/files")) {
      uploadIndex += 1;
      return new Response(JSON.stringify({ data: { fileId: `file-${uploadIndex}` } }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ jobId: "job-123", status: "queued", requestId: "req-123" }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const form = new FormData();
    form.append("files", new File(["a,b\n1,2"], "production.csv", { type: "text/csv" }));
    form.append("files", new File(["xlsx"], "abnormal.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
    form.append("eda_summary", JSON.stringify(validReport));
    const response = await worker.fetch(new Request("https://worker.example/api/analysis-jobs", {
      method: "POST",
      headers: { origin: "https://jasonlhc.github.io" },
      body: form,
    }), env);
    const result = await response.json();

    assert.equal(response.status, 202);
    assert.equal(result.job_id, "job-123");
    assert.equal(result.request_id, "req-123");
    assert.equal(requests.length, 3);
    assert.equal(requests[0].url, "https://backend-api.laplaceai.co/api/v1/invoke/ep_test/files");
    assert.equal(requests[1].url, "https://backend-api.laplaceai.co/api/v1/invoke/ep_test/files");
    for (const request of requests.slice(0, 2)) {
      assert.equal(request.headers.get("authorization"), "Bearer ep_secret_test");
      const upstreamForm = await request.formData();
      assert.ok(upstreamForm.get("fileToUpload") instanceof File);
    }
    assert.equal(requests[2].url, "https://backend-api.laplaceai.co/api/v1/invoke/ep_test/jobs");
    const jobBody = JSON.parse(await requests[2].text());
    assert.deepEqual(jobBody.attachments, [{ fileId: "file-1" }, { fileId: "file-2" }]);
    assert.equal(jobBody.locale, "zh-TW");
    assert.match(jobBody.message, /fetch_uploaded_file/);
    assert.equal(response.headers.get("access-control-allow-origin"), "https://jasonlhc.github.io");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Worker proxies job status and result", async () => {
  const worker = (await import("../worker/src/index.js")).default;
  const originalFetch = global.fetch;
  let upstreamRequest;
  global.fetch = async (input, init) => {
    upstreamRequest = new Request(input, init);
    return new Response(JSON.stringify({
      data: { jobId: "job-123", status: "done", result: { message: { content: "完成" } } },
      requestId: "req-result",
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  try {
    const response = await worker.fetch(new Request("https://worker.example/api/analysis-jobs/job-123"), env);
    const result = await response.json();
    assert.equal(upstreamRequest.url, "https://backend-api.laplaceai.co/api/v1/invoke/ep_test/jobs/job-123");
    assert.equal(result.status, "done");
    assert.equal(result.result.message.content, "完成");
    assert.equal(result.request_id, "req-result");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Worker preserves nested Laplace errors, HTTP status, and requestId", async () => {
  const worker = (await import("../worker/src/index.js")).default;
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({
    error: { code: "invalid_file", message: "檔案格式錯誤", requestId: "req-nested" },
  }), { status: 422, headers: { "content-type": "application/json" } });
  try {
    const form = new FormData();
    form.append("file", new File(["bad"], "bad.xlsx"));
    const response = await worker.fetch(new Request("https://worker.example/api/analysis-jobs", { method: "POST", body: form }), env);
    const result = await response.json();
    assert.equal(response.status, 422);
    assert.equal(result.code, "invalid_file");
    assert.equal(result.request_id, "req-nested");
    assert.equal(result.upstream_status, 422);
    assert.match(result.error, /檔案格式錯誤/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Worker rejects JSON-only analysis requests", async () => {
  const worker = (await import("../worker/src/index.js")).default;
  const response = await worker.fetch(new Request("https://worker.example/api/analysis-jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ eda_summary: validReport }),
  }), env);
  assert.equal(response.status, 415);
});
