# Analysis scripts

This folder contains the Python scripts for the grocery sales analysis.

- `sales_analysis.py` reads the source CSV from `../data/` and writes generated
  analysis files to `../outputs/`.
- `build_html_report.py` reads the source CSV and analysis outputs, then writes
  `../sales_findings.html`.

Run both scripts from the project root using the commands in the parent
[README](../README.md). Paths are resolved from the project root, so the
commands also work when invoked from another working directory.
