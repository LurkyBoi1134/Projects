# Project: Analysis scripts

## Purpose

Keep the SQL analysis, Python analysis, and report-generation scripts together,
separate from the source data and generated report.

## Files

- `sales_analysis.py` analyzes the source grocery sales CSV.
- `build_html_report.py` builds the standalone HTML report from the data and
  generated analysis outputs.
- `sales_analysis.sql` imports the same source CSV with the SQLite CLI and
  exports the analytical summaries as CSV files.

## Change guidance

The Python scripts anchor data and output paths at the parent project
directory. The SQL CLI script uses paths relative to the project root. Preserve
these conventions when changing file locations or execution instructions. See
the parent project's [README](../README.md) for setup and commands.
