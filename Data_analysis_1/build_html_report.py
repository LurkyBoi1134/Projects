"""Build a self-contained HTML report from the sales analysis outputs."""

import base64
import html
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parent
OUTPUTS = ROOT / "outputs"
DESTINATION = ROOT / "sales_findings.html"
DATA_PATH = ROOT / "data" / "Supermart Grocery Sales - Retail Analytics Dataset.csv"


def image_data(filename: str) -> str:
    encoded = base64.b64encode((OUTPUTS / filename).read_bytes()).decode("ascii")
    return f"data:image/png;base64,{encoded}"


def money(value: float, decimals: int = 0) -> str:
    return f"{value:,.{decimals}f}"


def main() -> None:
    raw = pd.read_csv(DATA_PATH)
    summary = {}
    for line in (OUTPUTS / "analysis_summary.txt").read_text(encoding="utf-8").splitlines():
        key, value = line.split(": ", 1)
        summary[key] = value

    categories = pd.read_csv(OUTPUTS / "category_summary.csv").sort_values("Sales", ascending=False)
    regions = pd.read_csv(OUTPUTS / "region_summary.csv").sort_values("Sales", ascending=False)
    category_rows = "\n".join(
        f"<tr><th scope=\"row\">{html.escape(row['Category'])}</th>"
        f"<td>{money(row['Sales'])}</td><td>{money(row['Profit'], 2)}</td>"
        f"<td>{row['Mean_Profit_Margin']:.1%}</td></tr>"
        for _, row in categories.iterrows()
    )
    region_rows = "\n".join(
        f"<tr{' class=\"warning-row\"' if int(row['Orders']) < 30 else ''}><th scope=\"row\">{html.escape(row['Region'])}</th>"
        f"<td>{int(row['Orders']):,}</td><td>{money(row['Sales'])}</td>"
        f"<td>{money(row['Profit'], 2)}</td></tr>"
        for _, row in regions.iterrows()
    )
    sample_rows = "\n".join(
        "<tr>"
        f"<th scope=\"row\">{index + 1}</th>"
        + "".join(
            f"<td>{html.escape(str(row[column]))}</td>"
            for column in ["Order ID", "Customer Name", "Category", "Sub Category", "City", "Order Date", "Region"]
        )
        + f"<td>{money(row['Sales'])}</td><td>{float(row['Discount']):.2f}</td>"
        + f"<td>{money(row['Profit'], 2)}</td><td>{html.escape(str(row['State']))}</td>"
        + "</tr>"
        for index, (_, row) in enumerate(raw.head(10).iterrows())
    )
    chart = lambda filename, alt: (
        f'<img src="{image_data(filename)}" alt="{html.escape(alt)}" loading="lazy">'
    )

    document = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="theme-color" content="#f4f2ec">
  <title>Grocery sales, made visible — Sales analysis</title>
  <style>
    :root {{ color-scheme: light; --ink:#182c31; --muted:#66777a; --paper:#f4f2ec; --card:#fffefa; --line:#dfe5df; --green:#176b58; --lime:#d6e7b2; --orange:#e58b52; }}
    * {{ box-sizing:border-box; }}
    html {{ scroll-behavior:smooth; }}
    body {{ margin:0; background:var(--paper); color:var(--ink); font:16px/1.55 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
    a {{ color:inherit; }}
    .shell {{ max-width:1240px; margin:auto; padding:0 40px; }}
    .masthead {{ display:flex; justify-content:space-between; align-items:center; padding:22px 0; border-bottom:1px solid #d7ded8; }}
    .brand {{ display:flex; gap:11px; align-items:center; font-weight:750; letter-spacing:-.02em; }}
    .brand-mark {{ display:grid; place-items:center; width:34px; height:34px; border-radius:11px; color:#eff7df; background:var(--green); font-size:18px; }}
    .mast-meta {{ color:var(--muted); font-size:13px; }}
    .hero {{ position:relative; overflow:hidden; margin:34px 0 22px; padding:54px 58px 48px; border-radius:24px; color:#f8f7ee; background:#173c3b; }}
    .hero:after {{ content:""; position:absolute; width:360px; height:360px; right:-105px; top:-170px; border-radius:50%; border:1px solid #ffffff26; box-shadow:0 0 0 38px #ffffff0b,0 0 0 78px #ffffff08; }}
    .eyebrow {{ color:#c7d9ae; text-transform:uppercase; letter-spacing:.15em; font-size:11px; font-weight:750; }}
    h1 {{ max-width:720px; margin:12px 0 12px; font-size:clamp(36px,5vw,62px); line-height:1.03; letter-spacing:-.055em; font-weight:680; }}
    .hero p {{ max-width:650px; color:#d5e0d8; margin:0; font-size:17px; }}
    .hero-foot {{ display:flex; gap:10px; flex-wrap:wrap; margin-top:28px; }}
    .pill {{ border:1px solid #ffffff36; border-radius:999px; padding:6px 11px; font-size:12px; color:#eef2e8; }}
    .conclusion {{ margin:0 0 58px; padding:28px; border:1px solid #cdddcf; border-radius:19px; background:#e7ede3; }}
    .conclusion-copy {{ max-width:900px; margin:7px 0 20px; font-size:18px; line-height:1.5; letter-spacing:-.015em; }}
    .stats {{ display:grid; grid-template-columns:repeat(4,1fr); gap:14px; margin:20px 0 0; }}
    .stat {{ min-height:130px; padding:20px 22px; border:1px solid var(--line); border-radius:16px; background:var(--card); }}
    .stat .label {{ color:var(--muted); font-size:12px; font-weight:650; letter-spacing:.07em; text-transform:uppercase; }}
    .stat strong {{ display:block; margin:9px 0 1px; font-size:clamp(24px,3vw,34px); letter-spacing:-.045em; line-height:1.15; }}
    .stat small {{ color:var(--muted); }}
    .section-head {{ display:flex; justify-content:space-between; gap:24px; align-items:end; margin:0 0 20px; }}
    .section-head h2 {{ margin:4px 0 0; font-size:29px; letter-spacing:-.04em; line-height:1.15; }}
    .section-head p {{ max-width:440px; margin:0; color:var(--muted); font-size:14px; }}
    .section-tag {{ color:var(--green); font-size:11px; font-weight:750; text-transform:uppercase; letter-spacing:.13em; }}
    .chart-grid {{ display:grid; grid-template-columns:1fr 1fr; gap:16px; }}
    .chart-card {{ min-width:0; padding:20px; border:1px solid var(--line); border-radius:18px; background:var(--card); }}
    .chart-title {{ display:flex; justify-content:space-between; align-items:baseline; gap:10px; margin:0 0 8px; font-size:16px; letter-spacing:-.02em; }}
    .chart-title span {{ color:var(--muted); font-size:11px; font-weight:500; letter-spacing:0; }}
    .chart-card img {{ display:block; width:100%; height:auto; }}
    .chart-note {{ margin:10px 0 0; padding-top:12px; border-top:1px solid #edf0eb; color:var(--muted); font-size:12px; }}
    .source-card {{ padding:22px 24px; border:1px solid var(--line); border-radius:17px; background:var(--card); }}
    .source-grid {{ display:grid; grid-template-columns:1fr 1fr; gap:12px 26px; margin:16px 0 0; }}
    .source-grid div {{ border-top:1px solid #edf0eb; padding-top:9px; }}
    .source-grid dt {{ color:var(--muted); font-size:11px; font-weight:750; letter-spacing:.07em; text-transform:uppercase; }}
    .source-grid dd {{ margin:2px 0 0; font-size:14px; }}
    .source-link {{ color:var(--green); font-weight:700; text-decoration-thickness:1px; text-underline-offset:3px; overflow-wrap:anywhere; }}
    .sr-only {{ position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }}
    .sample-wrap {{ margin-top:16px; overflow:auto; border:1px solid var(--line); border-radius:13px; background:var(--card); }}
    .sample-wrap table {{ min-width:1150px; font-size:12px; }}
    .sample-wrap th,.sample-wrap td {{ padding:9px 11px; }}
    .sample-caption {{ display:flex; justify-content:space-between; gap:14px; margin:12px 2px 0; color:var(--muted); font-size:12px; }}
    .steps {{ display:grid; grid-template-columns:repeat(3,1fr); gap:13px; margin:17px 0 58px; }}
    .step {{ padding:19px; border:1px solid var(--line); border-radius:15px; background:var(--card); }}
    .step-num {{ display:grid; place-items:center; width:27px; height:27px; border-radius:50%; color:white; background:var(--green); font-size:12px; font-weight:800; }}
    .step h3 {{ margin:12px 0 6px; font-size:16px; letter-spacing:-.02em; }}
    .step p {{ margin:0; color:var(--muted); font-size:13px; }}
    .analysis-section {{ margin-top:0; }}
    .insight-grid {{ display:grid; grid-template-columns:repeat(3,1fr); gap:14px; margin:18px 0 58px; }}
    .insight {{ min-height:176px; padding:22px; border-radius:16px; background:#e7ede3; }}
    .insight:nth-child(2) {{ background:#f1e8d8; }} .insight:nth-child(3) {{ background:#dcebe5; }}
    .insight .number {{ color:var(--green); font-size:12px; font-weight:800; letter-spacing:.1em; }}
    .insight h3 {{ margin:12px 0 7px; font-size:19px; letter-spacing:-.03em; }}
    .insight p {{ margin:0; color:#536567; font-size:14px; }}
    .tables {{ display:grid; grid-template-columns:1.15fr .85fr; gap:16px; margin-bottom:58px; }}
    .table-card {{ min-width:0; overflow:hidden; border:1px solid var(--line); border-radius:18px; background:var(--card); }}
    .table-head {{ padding:20px 22px 12px; }} .table-head h3 {{ margin:0; font-size:18px; letter-spacing:-.03em; }} .table-head p {{ margin:4px 0 0; color:var(--muted); font-size:12px; }}
    .table-scroll {{ overflow:auto; }}
    table {{ width:100%; border-collapse:collapse; font-size:13px; white-space:nowrap; }}
    th,td {{ padding:11px 15px; border-top:1px solid #edf0eb; text-align:right; }}
    thead th {{ color:var(--muted); font-size:10px; text-transform:uppercase; letter-spacing:.07em; font-weight:700; }}
    th:first-child,td:first-child {{ text-align:left; padding-left:22px; }}
    tbody th {{ font-weight:650; }}
    .warning-row {{ background:#fbf2e7; }} .warning-row th:after {{ content:" · low sample"; color:#a05c2d; font-size:10px; font-weight:600; }}
    .caveat {{ display:grid; grid-template-columns:32px 1fr; gap:14px; margin-bottom:58px; padding:20px 23px; border:1px solid #e6d6b8; border-radius:16px; background:#fbf3e5; }}
    .caveat-icon {{ display:grid; place-items:center; width:30px; height:30px; border-radius:50%; color:#79582c; background:#f0dfbf; font-weight:800; }}
    .caveat h3 {{ margin:1px 0 4px; font-size:15px; }} .caveat p {{ margin:0; color:#655e52; font-size:13px; }}
    footer {{ display:flex; justify-content:space-between; gap:20px; padding:21px 0 34px; border-top:1px solid #d7ded8; color:var(--muted); font-size:12px; }}
    footer a {{ color:var(--green); font-weight:700; text-decoration:none; }} footer a:hover {{ text-decoration:underline; }}
    @media(max-width:800px) {{ .shell {{ padding:0 22px; }} .hero {{ padding:40px 30px; }} .stats {{ grid-template-columns:1fr 1fr; }} .chart-grid,.tables {{ grid-template-columns:1fr; }} .insight-grid,.steps {{ grid-template-columns:1fr; margin-bottom:42px; }} .section-head {{ align-items:start; flex-direction:column; }} }}
    @media(max-width:480px) {{ .shell {{ padding:0 15px; }} .mast-meta {{ display:none; }} .hero {{ margin-top:20px; padding:34px 23px; border-radius:18px; }} .hero p {{ font-size:15px; }} .stats {{ gap:9px; }} .stat {{ min-height:112px; padding:15px; }} .stat strong {{ font-size:24px; }} .chart-card {{ padding:14px; }} .section-head h2 {{ font-size:25px; }} footer {{ flex-direction:column; }} }}
    @media(prefers-reduced-motion:reduce) {{ html {{ scroll-behavior:auto; }} }}
  </style>
</head>
<body>
  <div class="shell">
    <header class="masthead">
      <div class="brand"><span class="brand-mark" aria-hidden="true">↗</span> Fieldnotes <span style="font-weight:450;color:#718083">/ Sales intelligence</span></div>
      <div class="mast-meta">EXPLORATORY REPORT &nbsp;·&nbsp; 2015—2018</div>
    </header>
    <main>
      <section class="hero" aria-labelledby="report-title">
        <div class="eyebrow">Retail analytics · Tamil Nadu, India</div>
        <h1 id="report-title">Grocery sales,<br>made visible.</h1>
        <p>A first look at four years of order-level sales: where revenue comes from, which categories return the most profit, and what the discount patterns can—and cannot—tell us.</p>
        <div class="hero-foot"><span class="pill">9,994 orders</span><span class="pill">7 product categories</span><span class="pill">5 recorded regions</span></div>
      </section>

      <section class="conclusion" aria-labelledby="conclusion-heading">
        <div class="section-tag">Executive conclusion</div>
        <h2 id="conclusion-heading" style="margin:5px 0 0;font-size:27px;letter-spacing:-.04em">Sales climbed; profitability stayed broadly consistent.</h2>
        <p class="conclusion-copy">Across 9,994 recorded orders, the dataset reports {money(float(summary['total_sales']))} in sales and {money(float(summary['total_profit']), 2)} in profit, for a 25.1% overall margin. Annual sales increased 67.3% from 2015 to 2018. Eggs, Meat &amp; Fish led sales, while Snacks generated the most profit. Discount bands show similar average margins, but this comparison alone cannot establish a discount effect.</p>
        <div class="stats" aria-label="Headline metrics">
        <article class="stat"><div class="label">Sales</div><strong>{money(float(summary['total_sales']))}</strong><small>across all recorded orders</small></article>
        <article class="stat"><div class="label">Profit</div><strong>{money(float(summary['total_profit'])/1_000_000, 2)}M</strong><small>reported profit units</small></article>
        <article class="stat"><div class="label">Profit margin</div><strong>{float(summary['overall_profit_margin']):.1%}</strong><small>profit ÷ sales</small></article>
        <article class="stat"><div class="label">Average discount</div><strong>{float(summary['mean_discount']):.1%}</strong><small>mean discount per order</small></article>
        </div>
      </section>

      <section aria-labelledby="source-heading" style="margin-bottom:58px">
        <div class="section-head"><div><div class="section-tag">01 / Dataset</div><h2 id="source-heading">Source &amp; sample</h2></div><p>Source attribution and a small, unmodified sample are shown before the cleaning notes and analysis.</p></div>
        <article class="source-card">
          <div class="section-tag">Primary data source</div>
          <dl class="source-grid">
            <div><dt>Dataset</dt><dd>Supermart Grocery Sales – Retail Analytics Dataset</dd></div>
            <div><dt>Platform / publisher</dt><dd>Kaggle · Mohamed Harris</dd></div>
            <div><dt>Source file</dt><dd>Supermart Grocery Sales - Retail Analytics Dataset.csv</dd></div>
            <div><dt>Records and fields</dt><dd>9,994 order rows · 11 columns</dd></div>
            <div><dt>Coverage</dt><dd>January 2, 2015 – December 30, 2018 · Tamil Nadu, India</dd></div>
            <div><dt>Currency</dt><dd>Not specified in the source; values are shown without a currency symbol</dd></div>
            <div><dt>Dataset page</dt><dd><a class="source-link" href="https://www.kaggle.com/datasets/mohamedharris/supermart-grocery-sales-retail-analytics-dataset" target="_blank" rel="noopener noreferrer">Open the Kaggle dataset page ↗</a></dd></div>
          </dl>
        </article>
        <div class="sample-caption"><strong>10 sample records from the downloaded source CSV</strong><span>Source order preserved · dates and numeric fields shown as stored</span></div>
        <div class="sample-wrap" role="region" aria-label="Scrollable 10-row sample data table" tabindex="0">
          <table><caption class="sr-only">First 10 rows from the source dataset</caption><thead><tr><th scope="col">#</th><th scope="col">Order ID</th><th scope="col">Customer</th><th scope="col">Category</th><th scope="col">Subcategory</th><th scope="col">City</th><th scope="col">Order date (raw)</th><th scope="col">Region</th><th scope="col">Sales</th><th scope="col">Discount (raw)</th><th scope="col">Profit</th><th scope="col">State</th></tr></thead><tbody>{sample_rows}</tbody></table>
        </div>
      </section>

      <section aria-labelledby="cleaning-heading">
        <div class="section-head"><div><div class="section-tag">02 / Data preparation</div><h2 id="cleaning-heading">How the data was cleaned</h2></div><p>The raw CSV is retained. Cleaning prepares dates and analysis fields while preserving the original order-level records.</p></div>
        <div class="steps">
          <article class="step"><span class="step-num">1</span><h3>Load and inspect</h3><p>Read the 11 source columns, checked data types, null counts, duplicate rows, unique order IDs, and numeric ranges. Found 0 missing cells, 0 duplicate rows, and 9,994 unique IDs.</p></article>
          <article class="step"><span class="step-num">2</span><h3>Standardize dates</h3><p>The source mixes hyphen and slash formats. Hyphenated dates were parsed as day-month-year; slash dates were parsed as month/day/year. All {summary['date_parse_failures']} dates parsed successfully ({summary['date_start']} to {summary['date_end']}).</p></article>
          <article class="step"><span class="step-num">3</span><h3>Create analysis fields</h3><p>Derived year, month, and profit margin (profit ÷ sales) for grouping and comparison. Kept sales, profit, discounts, and categories unchanged; no rows were dropped or imputed.</p></article>
        </div>
      </section>

      <section class="analysis-section" aria-labelledby="charts-heading">
        <div class="section-head"><div><div class="section-tag">03 / Analysis</div><h2 id="charts-heading">Sales and profit patterns</h2></div><p>Explore the time trend, category mix, and regional concentration, then compare the detailed totals below.</p></div>
        <div class="chart-grid">
          <article class="chart-card"><h3 class="chart-title">Monthly sales <span>2015—2018</span></h3>{chart('monthly_sales.png','Line chart of total sales by month from 2015 to 2018')}<p class="chart-note">Monthly totals show the overall trajectory; annual comparisons are less sensitive to month-to-month variation.</p></article>
          <article class="chart-card"><h3 class="chart-title">Sales by category <span>total sales</span></h3>{chart('sales_by_category.png','Bar chart ranking sales by product category')}<p class="chart-note">Eggs, Meat &amp; Fish is the largest category by sales, narrowly ahead of Snacks.</p></article>
          <article class="chart-card"><h3 class="chart-title">Profit by category <span>total profit</span></h3>{chart('profit_by_category.png','Bar chart ranking profit by product category')}<p class="chart-note">Snacks contributes the most total profit, even though it is second in sales.</p></article>
          <article class="chart-card"><h3 class="chart-title">Sales by region <span>total sales</span></h3>{chart('sales_by_region.png','Bar chart ranking sales across five regions')}<p class="chart-note">West is the largest represented region. North appears once in the data.</p></article>
        </div>
      </section>

      <section aria-label="Analysis takeaways">
        <div class="section-head" style="margin-top:58px"><div><div class="section-tag">Analysis takeaways</div><h2>Signals in the records</h2></div><p>These are descriptive patterns in the available records, not forecasts or causal estimates.</p></div>
        <div class="insight-grid">
          <article class="insight"><div class="number">01 — MOMENTUM</div><h3>Sales grew 67.3%</h3><p>Annual sales rose from 2.98M in 2015 to 4.98M in 2018. The data shows a strong upward trend across the period.</p></article>
          <article class="insight"><div class="number">02 — CATEGORY MIX</div><h3>Sales leader ≠ profit leader</h3><p>Eggs, Meat &amp; Fish led sales at 2.27M; Snacks led profit at 568.2K. Revenue rank alone misses differences in profitability.</p></article>
          <article class="insight"><div class="number">03 — DISCOUNTS</div><h3>Margins look steady</h3><p>Average profit margin ranges from 24.8% to 25.6% across discount bands. This simple comparison does not establish a discount effect.</p></article>
        </div>
      </section>

      <section aria-labelledby="tables-heading">
        <div class="section-head"><div><div class="section-tag">03 / Detail</div><h2 id="tables-heading">Category &amp; region scorecard</h2></div><p>Totals are shown alongside order-weighted margin and order counts for context.</p></div>
        <div class="tables">
          <article class="table-card"><div class="table-head"><h3>Product categories</h3><p>Sorted by recorded sales</p></div><div class="table-scroll"><table><thead><tr><th scope="col">Category</th><th scope="col">Sales</th><th scope="col">Profit</th><th scope="col">Mean margin</th></tr></thead><tbody>{category_rows}</tbody></table></div></article>
          <article class="table-card"><div class="table-head"><h3>Regions</h3><p>Order volume varies sharply</p></div><div class="table-scroll"><table><thead><tr><th scope="col">Region</th><th scope="col">Orders</th><th scope="col">Sales</th><th scope="col">Profit</th></tr></thead><tbody>{region_rows}</tbody></table></div></article>
        </div>
      </section>

      <aside class="caveat" aria-label="Data note"><div class="caveat-icon" aria-hidden="true">i</div><div><h3>Read the small print</h3><p>The North region has just one order, so its averages are not representative. The dataset has no missing cells or negative-profit orders in this first pass. Date strings use mixed formats and were parsed separately. The source provides no currency metadata, so monetary values are shown without a currency symbol. Similar margins across discount bands are correlation-style summaries only; product mix and other factors are not controlled.</p></div></aside>
    </main>
    <footer><span>Source: <a href="https://www.kaggle.com/datasets/mohamedharris/supermart-grocery-sales-retail-analytics-dataset" target="_blank" rel="noreferrer">Supermart Grocery Sales · Kaggle ↗</a></span><span>Prepared from 9,994 order records · Initial exploratory analysis</span></footer>
  </div>
</body>
</html>
"""
    DESTINATION.write_text(document, encoding="utf-8")
    print(f"Wrote {DESTINATION} ({DESTINATION.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
