const test = require("node:test");
const assert = require("node:assert/strict");
const { analyzeWorkbook } = require("../dist/eda-core.js");

test("summarizes production lines, weighted yield, missing data, and defects", () => {
  const report = analyzeWorkbook({
    fileName: "sample.xlsx",
    sheets: [{
      name: "品質資料",
      rows: [
        { 產線: "A12", 良品數: 95, 總數: 100, 不良原因: "厚度不足", 電流: 10 },
        { 產線: "A12", 良品數: 90, 總數: 100, 不良原因: "厚度不足", 電流: 11 },
        { 產線: "B07", 良品數: 99, 總數: 100, 不良原因: "刮傷", 電流: null },
      ],
    }],
  });

  assert.equal(report.template_id, "fuye-production-quality-v1");
  assert.equal(report.input_summary.row_count, 3);
  assert.equal(report.kpis.detected_line_count, 2);
  assert.equal(Math.round(report.kpis.overall_yield.value * 100) / 100, 94.67);
  assert.equal(report.defects[0].label, "厚度不足");
  assert.equal(report.data_quality.columns.find((column) => column.name === "電流").missing_count, 1);
});

test("normalizes fractional yield percentages", () => {
  const report = analyzeWorkbook({
    sheets: [{ name: "Sheet1", rows: [{ Line: "A", Yield: 0.98 }, { Line: "B", Yield: 0.96 }] }],
  });
  assert.equal(report.kpis.overall_yield.value, 97);
});

test("marks summaries as sampled when a sheet exceeds the configured limit", () => {
  const report = analyzeWorkbook(
    { sheets: [{ name: "Sheet1", rows: [{ value: 1 }, { value: 2 }, { value: 3 }] }] },
    { maxRowsPerSheet: 2 },
  );
  assert.equal(report.input_summary.sampled, true);
  assert.equal(report.input_summary.analyzed_row_count, 2);
});

test("classifies production parameter files", () => {
  const report = analyzeWorkbook({
    fileName: "A12_生產參數.xlsx",
    sheets: [{ name: "參數", rows: [{ 產線: "A12", 電流: 10, 米速: 2.5 }] }],
  });
  assert.equal(report.data_type, "production_parameters");
  assert.equal(report.template_id, "fuye-production-parameters-v1");
});

test("classifies abnormal record files and honors manual selection", () => {
  const automatic = analyzeWorkbook({
    fileName: "異常紀錄.xlsx",
    sheets: [{ name: "異常", rows: [{ 產線: "A12", 不良原因: "厚度不足" }] }],
  });
  assert.equal(automatic.data_type, "abnormal_records");

  const manual = analyzeWorkbook({
    fileName: "unknown.xlsx",
    sheets: [{ name: "Sheet1", rows: [{ 值: 1 }] }],
  }, { dataType: "production_parameters" });
  assert.equal(manual.data_type, "production_parameters");
  assert.equal(manual.classification.source, "manual");
});
