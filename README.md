# LineSight 品質分析前端

以 Excel／CSV 為入口的多產線品質分析介面。目前包含：

- 檔案選擇、拖曳與基本格式驗證
- 瀏覽器內 XLSX／XLS／CSV 解析，不將檔案上傳到 GitHub
- 工作表、資料列、欄位型態、缺失率、數值統計與 IQR 離群值 EDA
- 產線、良率與不良原因欄位自動辨識
- 多產線 KPI、資料量圖、不良 Pareto 與比較表
- Cloudflare Worker → Laplace Agent 團隊附件上傳、任務建立與狀態查詢
- 可驗證的 `fuye-production-quality-v1` 報告 JSON schema 與 Agent prompt
- 桌面與行動裝置響應式版面

## 本機預覽

直接以靜態伺服器提供 `dist` 目錄即可。`index.html` 使用相對路徑，也可直接部署至 GitHub Pages。

## 架構

```text
GitHub Pages（靜態前端＋本機 EDA）
  → Cloudflare Worker（Secrets、CORS、檔案驗證與錯誤轉譯）
  → Laplace /files → /jobs → /jobs/{jobId}
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

- `LAPLACE_BASE_URL`：`https://backend-api.laplaceai.co`
- `LAPLACE_INVOKE_PATH`：`/api/v1/invoke/{endpointToken}`
- `ALLOWED_ORIGINS`：允許呼叫 Worker 的前端 origin

Secrets 只能透過 Cloudflare 設定，不可寫入 repository：

```powershell
npx wrangler secret put LAPLACE_ENDPOINT_SECRET
```

前端送至 Worker：

```http
POST {LAPLACE_API_BASE}/api/analysis-jobs
Content-Type: multipart/form-data
```

表單欄位：

- `files`: 一至兩份 XLSX、XLS 或 CSV；單檔上限 50 MB
- `eda_summary`: 每份檔案各自產生的 EDA JSON，可重複傳送

Worker 逐份將檔案以 `fileToUpload` 轉送至團隊 `/files`，取得 `data.fileId` 後建立 `/jobs` 任務。前端使用 Worker 的 `GET /api/analysis-jobs/{jobId}` 輪詢結果。Endpoint secret 只存在 Worker，不會傳到瀏覽器。

Worker 會保留 Laplace 的 HTTP 狀態、頂層或巢狀錯誤碼、訊息與 `requestId`，以利追查串接問題。

> CORS 不是使用者驗證。公開部署 Worker 前仍應設定 Cloudflare Access、Turnstile 或其他濫用防護。

## 報告契約

- `contracts/report-template.schema.json`：Agent 正式報告的資料格式
- `contracts/agent-team-prompt.md`：證據分級、因果限制與必要章節

前端 EDA 只提供描述統計，不會把相關性當作根因，也不會在缺少規格上下限時推算 Cpk。

## 測試

```powershell
npm test
```
