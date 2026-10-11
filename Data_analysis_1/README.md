# Grocery Sales Analysis

Initial exploratory analysis of Kaggle's [Supermart Grocery Sales – Retail Analytics Dataset](https://www.kaggle.com/datasets/mohamedharris/supermart-grocery-sales-retail-analytics-dataset).

The source CSV is in `data/`. The dataset contains order-level grocery sales, including order date, category, subcategory, city, region, sales, discount, and profit. The data represents Tamil Nadu, India, and covers 2015–2018.

## Run

```bash
.venv/bin/python sales_analysis.py
```

The script writes summary tables, a text summary, and four charts to `outputs/`. Hyphenated order dates are interpreted as day-month-year; slash-formatted dates are parsed as month/day/year. The parser reports any failures in `outputs/analysis_summary.txt`.

Build the standalone HTML report after running the analysis:

```bash
.venv/bin/python build_html_report.py
```

This writes `sales_findings.html` with the conclusion first, a clearly attributed data source, 10 source sample rows, the cleaning procedure, and the analysis. Charts are embedded, so the report can be opened or shared as a single file.

The HTML report is self-contained and needs no companion assets. Generated analysis files in `outputs/` and the duplicate Kaggle ZIP are excluded from version control. The source CSV is kept in `data/` so the analysis can be reproduced; the report itself can be viewed without it.

## Initial questions

- How do monthly sales vary over time?
- Which product categories and regions contribute most to sales and profit?
- How do discount levels relate to profit and profit margin?
- Which cities and subcategories are strongest or weakest?

The dataset is suitable for exploratory analysis, but its Kaggle description should be consulted before using findings for real operational decisions.
