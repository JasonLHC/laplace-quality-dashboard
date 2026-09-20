# LineSight 品質分析前端

以 Excel／CSV 為入口的多產線品質分析介面。目前包含：

- 檔案選擇、拖曳與基本格式驗證
- 瀏覽器內 XLSX／XLS／CSV 解析，不將檔案上傳到 GitHub
- 工作表、資料列、欄位型態、缺失率、數值統計與 IQR 離群值 EDA
- 產線、良率與不良原因欄位自動辨識
- 多產線 KPI、資料量圖、不良 Pareto 與比較表
- Cloudflare Worker → Laplace 檔案上傳 → Agent 團隊呼叫骨架
- 可驗證的 `fuye-production-quality-v1` 報告 JSON schema 與 Agent prompt
- 桌面與行動裝置響應式版面

## 本機預覽

直接以靜態伺服器提供 `dist` 目錄即可。`index.html` 使用相對路徑，也可直接部署至 GitHub Pages。

## 架構

```text
GitHub Pages（靜態前端＋本機 EDA）
  → Cloudflare Worker（Secrets、CORS、附件轉送、Webhook 驗證）
  → Laplace /upload-file
  → Laplace /invoke/{team-endpoint}
```

GitHub Actions 只部署靜態網站，不處理使用者上傳的 Excel。

## 前端設定

在 `dist/config.js` 填入部署後的 Worker 公開位址：

```js
window.LINESIGHT_CONFIG = {
  apiBaseUrl: "https://linesight-laplace-gateway.example.workers.dev",
};
```

未設定時，網站只執行本機 EDA，並明確顯示檔案沒有離開瀏覽器。

## Cloudflare Worker 設定

`worker/wrangler.jsonc` 中需要確認：

- `LAPLACE_BASE_URL`：`https://www.laplaceai.co`
- `LAPLACE_UPLOAD_PATH`：`/api/backend/upload-file`
- `LAPLACE_INVOKE_PATH`：已建立的 Agent 團隊端點
- `ALLOWED_ORIGINS`：允許呼叫 Worker 的前端 origin

Secrets 只能透過 Cloudflare 設定，不可寫入 repository：

```powershell
npx wrangler secret put LAPLACE_ENDPOINT_SECRET
npx wrangler secret put LAPLACE_WEBHOOK_SECRET
```

前端送至 Worker：

```http
POST {LAPLACE_API_BASE}/api/analysis-jobs
Content-Type: multipart/form-data
```

欄位：

- `file`: Excel 或 CSV
- `analysis_type`: `production_quality`
- `template_id`: `fuye-production-quality-v1`
- `eda_summary`: 瀏覽器產生的 EDA JSON

Worker 會先以 `multipart/form-data` 傳送 `fileName` 與 `fileToUpload`。Laplace 成功時回傳 HTTP 201 與 `uploadFileId`，Worker 再用 `attachments: [{ fileId: uploadFileId }]` 呼叫 Agent 團隊。

若綁定 `ANALYSIS_RESULTS` KV、設定 `PUBLIC_WORKER_URL` 與 Webhook secret，Worker 會驗證 `X-Signature`、五分鐘時間窗並保存七天結果。

> CORS 不是使用者驗證。公開部署 Worker 前仍應設定 Cloudflare Access、Turnstile 或其他濫用防護。

## 報告契約

- `contracts/report-template.schema.json`：Agent 正式報告的資料格式
- `contracts/agent-team-prompt.md`：證據分級、因果限制與必要章節

前端 EDA 只提供描述統計，不會把相關性當作根因，也不會在缺少規格上下限時推算 Cpk。

## 測試

```powershell
npm test
```
