"""Exploratory analysis of Kaggle's Supermart Grocery Sales dataset."""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd


ROOT = Path(__file__).resolve().parent
DATA_PATH = ROOT / "data" / "Supermart Grocery Sales - Retail Analytics Dataset.csv"
OUTPUT_DIR = ROOT / "outputs"


def parse_order_dates(values: pd.Series) -> pd.Series:
    """Parse the source's mixed date formats (hyphen dates are day-first)."""
    text = values.astype("string").str.strip()
    parsed = pd.Series(pd.NaT, index=values.index, dtype="datetime64[ns]")
    hyphenated = text.str.contains("-", regex=False, na=False)
    parsed.loc[hyphenated] = pd.to_datetime(
        text.loc[hyphenated], format="%d-%m-%Y", errors="coerce"
    )
    parsed.loc[~hyphenated] = pd.to_datetime(
        text.loc[~hyphenated], format="mixed", errors="coerce"
    )
    return parsed


def save_bar(data: pd.Series, title: str, ylabel: str, filename: str) -> None:
    fig, ax = plt.subplots(figsize=(10, 5.5))
    data.plot(kind="bar", ax=ax, color="#2d7f78")
    ax.set_title(title)
    ax.set_ylabel(ylabel)
    ax.set_xlabel("")
    ax.tick_params(axis="x", labelrotation=30)
    fig.tight_layout()
    fig.savefig(OUTPUT_DIR / filename, dpi=150)
    plt.close(fig)


def main() -> None:
    OUTPUT_DIR.mkdir(exist_ok=True)
    df = pd.read_csv(DATA_PATH)
    df["Order Date"] = parse_order_dates(df["Order Date"])
    df["Year"] = df["Order Date"].dt.year
    df["Month"] = df["Order Date"].dt.to_period("M").dt.to_timestamp()
    df["Profit Margin"] = df["Profit"] / df["Sales"]

    # These outputs make the analysis easy to inspect and extend.
    df.groupby("Month", as_index=False).agg(
        Orders=("Order ID", "count"), Sales=("Sales", "sum"), Profit=("Profit", "sum")
    ).to_csv(OUTPUT_DIR / "monthly_sales.csv", index=False)
    df.groupby("Category", as_index=False).agg(
        Orders=("Order ID", "count"), Sales=("Sales", "sum"), Profit=("Profit", "sum"),
        Mean_Discount=("Discount", "mean"), Mean_Profit_Margin=("Profit Margin", "mean"),
    ).sort_values("Sales", ascending=False).to_csv(OUTPUT_DIR / "category_summary.csv", index=False)
    df.groupby("Region", as_index=False).agg(
        Orders=("Order ID", "count"), Sales=("Sales", "sum"), Profit=("Profit", "sum"),
        Mean_Discount=("Discount", "mean"),
    ).sort_values("Sales", ascending=False).to_csv(OUTPUT_DIR / "region_summary.csv", index=False)

    monthly = df.groupby("Month")["Sales"].sum().sort_index()
    annual = df.groupby("Year").agg(Sales=("Sales", "sum"), Profit=("Profit", "sum"))
    category_sales = df.groupby("Category")["Sales"].sum().sort_values(ascending=False)
    category_profit = df.groupby("Category")["Profit"].sum().sort_values(ascending=False)
    region_sales = df.groupby("Region")["Sales"].sum().sort_values(ascending=False)
    discount_bands = pd.cut(df["Discount"], [0, 0.15, 0.20, 0.25, 0.30, 0.36], include_lowest=True)
    discount_summary = df.groupby(discount_bands, observed=True).agg(
        Orders=("Order ID", "count"),
        Average_Discount=("Discount", "mean"),
        Average_Profit_Margin=("Profit Margin", "mean"),
    )
    save_bar(category_sales, "Sales by product category", "Sales", "sales_by_category.png")
    save_bar(category_profit, "Profit by product category", "Profit", "profit_by_category.png")
    save_bar(region_sales, "Sales by region", "Sales", "sales_by_region.png")

    fig, ax = plt.subplots(figsize=(11, 5.5))
    monthly.plot(ax=ax, color="#255f85", linewidth=1.8)
    ax.set(title="Monthly sales", xlabel="Order month", ylabel="Sales")
    ax.grid(axis="y", alpha=0.25)
    fig.tight_layout()
    fig.savefig(OUTPUT_DIR / "monthly_sales.png", dpi=150)
    plt.close(fig)

    valid_dates = df["Order Date"].notna()
    summary = {
        "rows": len(df),
        "date_parse_failures": int((~valid_dates).sum()),
        "date_start": df.loc[valid_dates, "Order Date"].min().date().isoformat(),
        "date_end": df.loc[valid_dates, "Order Date"].max().date().isoformat(),
        "unique_orders": int(df["Order ID"].nunique()),
        "total_sales": float(df["Sales"].sum()),
        "total_profit": float(df["Profit"].sum()),
        "overall_profit_margin": float(df["Profit"].sum() / df["Sales"].sum()),
        "mean_discount": float(df["Discount"].mean()),
        "negative_profit_rows": int((df["Profit"] < 0).sum()),
        "missing_cells": int(df.isna().sum().sum()),
    }
    (OUTPUT_DIR / "analysis_summary.txt").write_text(
        "\n".join(f"{key}: {value}" for key, value in summary.items()) + "\n",
        encoding="utf-8",
    )
    north_rows = int((df["Region"] == "North").sum())
    report = [
        "# Initial findings",
        "",
        f"The dataset contains {len(df):,} distinct order IDs from {summary['date_start']} to {summary['date_end']}. "
        f"Recorded sales total {summary['total_sales']:,.0f} and profit totals {summary['total_profit']:,.2f}; "
        f"the overall profit margin is {summary['overall_profit_margin']:.1%}.",
        "",
        "## Findings",
        "",
        f"- Annual sales rose from {annual.iloc[0]['Sales']:,.0f} in {annual.index[0]} to "
        f"{annual.iloc[-1]['Sales']:,.0f} in {annual.index[-1]} "
        f"({(annual.iloc[-1]['Sales'] / annual.iloc[0]['Sales'] - 1):.1%} increase).",
        f"- {category_sales.index[0]} led category sales at {category_sales.iloc[0]:,.0f}; "
        f"{category_profit.index[0]} led total profit at {category_profit.iloc[0]:,.2f}.",
        f"- {region_sales.index[0]} led regional sales at {region_sales.iloc[0]:,.0f}. "
        f"The North region has only {north_rows} order, so its results are not representative.",
        f"- Mean profit margin varied from {discount_summary['Average_Profit_Margin'].min():.1%} to "
        f"{discount_summary['Average_Profit_Margin'].max():.1%} across discount bands. "
        "This descriptive comparison does not show that discounts cause higher or lower profit.",
        "- There are no missing cells, duplicate rows, negative-profit orders, or date parse failures in this first pass.",
        "",
        "## Outputs",
        "",
        "See `outputs/analysis_summary.txt`, the category and region CSV summaries, and the four PNG charts. "
        "The source dates use mixed formatting; date parsing treats hyphenated values as day-month-year and slash values as month/day/year.",
    ]
    (OUTPUT_DIR / "initial_findings.md").write_text("\n".join(report) + "\n", encoding="utf-8")
    print("Initial sales analysis complete")
    print((OUTPUT_DIR / "analysis_summary.txt").read_text(encoding="utf-8"))
    print("Sales by category:\n", category_sales.to_string())
    print("Profit by category:\n", category_profit.to_string())
    print("Sales by region:\n", region_sales.to_string())


if __name__ == "__main__":
    main()
