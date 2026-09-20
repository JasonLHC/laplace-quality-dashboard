# LineSight 品質分析前端

以 Excel／CSV 為入口的多產線品質分析介面。第一版包含：

- 檔案選擇、拖曳與基本格式驗證
- 分析任務進度
- 多產線品質 KPI、趨勢、不良 Pareto 與比較表
- Laplace AI 優化建議區
- 桌面與行動裝置響應式版面

## 本機預覽

直接以靜態伺服器提供 `dist` 目錄即可。`index.html` 使用相對路徑，也可直接部署至 GitHub Pages。

## Laplace API 串接

正式環境由後端或部署設定提供：

```html
<script>window.LAPLACE_API_BASE = "https://your-api.example.com";</script>
```

設定後，前端會將檔案送至：

```http
POST {LAPLACE_API_BASE}/api/analysis-jobs
Content-Type: multipart/form-data
```

欄位：

- `file`: Excel 或 CSV
- `analysis_type`: `production_quality`

API Key 必須保存在後端，禁止放進這個 repository 或瀏覽器程式碼。

未設定 API 位址時，介面以明確標示的示範模式運作，不會上傳檔案。
