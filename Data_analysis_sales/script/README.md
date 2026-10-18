# Analysis scripts

This folder contains the Python and SQLite scripts for the grocery sales
analysis.

- `sales_analysis.py` reads the source CSV from `../data/` and writes generated
  analysis files to `../outputs/`.
- `build_html_report.py` reads the source CSV and analysis outputs, then writes
  `../sales_findings.html`.
- `sales_analysis.sql` imports the source CSV using the SQLite CLI and writes
  summary CSVs to `../outputs/`.

Run both scripts from the project root using the commands in the parent
[README](../README.md). Paths are resolved from the project root, so the
Python commands also work when invoked from another working directory. The SQL
script expects to be run from the project root because its import and output
paths are relative.
