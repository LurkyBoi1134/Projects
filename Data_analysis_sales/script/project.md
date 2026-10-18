# Project: Analysis scripts

## Purpose

Keep the Python analysis and report-generation scripts together, separate from
the source data and generated report.

## Files

- `sales_analysis.py` analyzes the source grocery sales CSV.
- `build_html_report.py` builds the standalone HTML report from the data and
  generated analysis outputs.

## Change guidance

The scripts anchor data and output paths at the parent project directory.
Preserve that behavior when changing file locations or execution instructions.
See the parent project's [README](../README.md) for setup and commands.
