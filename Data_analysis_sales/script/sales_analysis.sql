.bail on
.mode csv
.headers on

DROP TABLE IF EXISTS raw_sales;

CREATE TABLE raw_sales (
    "Order ID" TEXT,
    "Customer Name" TEXT,
    "Category" TEXT,
    "Sub Category" TEXT,
    "City" TEXT,
    "Order Date" TEXT,
    "Region" TEXT,
    "Sales" REAL,
    "Discount" REAL,
    "Profit" REAL,
    "State" TEXT
);

.import --csv --skip 1 "data/Supermart Grocery Sales - Retail Analytics Dataset.csv" raw_sales

CREATE TEMP VIEW normalized_sales AS
WITH date_parts AS (
    SELECT
        *,
        trim("Order Date") AS source_date,
        instr(trim("Order Date"), '/') AS first_slash,
        instr(
            substr(trim("Order Date"), instr(trim("Order Date"), '/') + 1),
            '/'
        ) AS second_slash_offset
    FROM raw_sales
),
normalized_dates AS (
    SELECT
        *,
        CASE
            WHEN instr(source_date, '-') > 0 THEN
                substr(source_date, 7, 4) || '-' ||
                substr(source_date, 4, 2) || '-' ||
                substr(source_date, 1, 2)
            WHEN first_slash > 0 THEN
                substr(source_date, first_slash + second_slash_offset + 1, 4) || '-' ||
                printf('%02d', CAST(substr(source_date, 1, first_slash - 1) AS INTEGER)) || '-' ||
                printf(
                    '%02d',
                    CAST(
                        substr(
                            source_date,
                            first_slash + 1,
                            second_slash_offset - 1
                        ) AS INTEGER
                    )
                )
        END AS iso_date
    FROM date_parts
)
SELECT
    "Order ID",
    "Customer Name",
    "Category",
    "Sub Category",
    "City",
    "Region",
    "State",
    "Sales",
    "Discount",
    "Profit",
    date(iso_date) AS order_date,
    "Profit" / NULLIF("Sales", 0) AS profit_margin
FROM normalized_dates;

.output outputs/monthly_sales.csv
SELECT
    strftime('%Y-%m-01', order_date) AS Month,
    COUNT("Order ID") AS Orders,
    SUM("Sales") AS Sales,
    SUM("Profit") AS Profit
FROM normalized_sales
WHERE order_date IS NOT NULL
GROUP BY Month
ORDER BY Month;

.output outputs/category_summary.csv
SELECT
    "Category",
    COUNT("Order ID") AS Orders,
    SUM("Sales") AS Sales,
    SUM("Profit") AS Profit,
    AVG("Discount") AS Mean_Discount,
    AVG(profit_margin) AS Mean_Profit_Margin
FROM normalized_sales
GROUP BY "Category"
ORDER BY Sales DESC;

.output outputs/region_summary.csv
SELECT
    "Region",
    COUNT("Order ID") AS Orders,
    SUM("Sales") AS Sales,
    SUM("Profit") AS Profit,
    AVG("Discount") AS Mean_Discount
FROM normalized_sales
GROUP BY "Region"
ORDER BY Sales DESC;

.output outputs/annual_sales.csv
SELECT
    strftime('%Y', order_date) AS Year,
    SUM("Sales") AS Sales,
    SUM("Profit") AS Profit
FROM normalized_sales
WHERE order_date IS NOT NULL
GROUP BY Year
ORDER BY Year;

.output outputs/discount_summary.csv
WITH bands AS (
    SELECT
        CASE
            WHEN "Discount" BETWEEN 0 AND 0.15 THEN '0.00-0.15'
            WHEN "Discount" > 0.15 AND "Discount" <= 0.20 THEN '0.15-0.20'
            WHEN "Discount" > 0.20 AND "Discount" <= 0.25 THEN '0.20-0.25'
            WHEN "Discount" > 0.25 AND "Discount" <= 0.30 THEN '0.25-0.30'
            WHEN "Discount" > 0.30 AND "Discount" <= 0.36 THEN '0.30-0.36'
        END AS Discount_Band,
        "Order ID",
        "Discount",
        profit_margin
    FROM normalized_sales
)
SELECT
    Discount_Band,
    COUNT("Order ID") AS Orders,
    AVG("Discount") AS Average_Discount,
    AVG(profit_margin) AS Average_Profit_Margin
FROM bands
WHERE Discount_Band IS NOT NULL
GROUP BY Discount_Band
ORDER BY Discount_Band;

.output outputs/data_quality.csv
SELECT 'rows' AS metric, COUNT(*) AS value FROM normalized_sales
UNION ALL
SELECT 'date_parse_failures', SUM(CASE WHEN order_date IS NULL THEN 1 ELSE 0 END)
FROM normalized_sales
UNION ALL
SELECT 'date_start', MIN(order_date) FROM normalized_sales
UNION ALL
SELECT 'date_end', MAX(order_date) FROM normalized_sales
UNION ALL
SELECT 'unique_orders', COUNT(DISTINCT "Order ID") FROM normalized_sales
UNION ALL
SELECT 'total_sales', SUM("Sales") FROM normalized_sales
UNION ALL
SELECT 'total_profit', SUM("Profit") FROM normalized_sales
UNION ALL
SELECT 'overall_profit_margin', SUM("Profit") / NULLIF(SUM("Sales"), 0)
FROM normalized_sales
UNION ALL
SELECT 'mean_discount', AVG("Discount") FROM normalized_sales
UNION ALL
SELECT 'negative_profit_rows', SUM(CASE WHEN "Profit" < 0 THEN 1 ELSE 0 END)
FROM normalized_sales
UNION ALL
SELECT
    'missing_cells',
    SUM(
        (NULLIF(trim("Order ID"), '') IS NULL) +
        (NULLIF(trim("Customer Name"), '') IS NULL) +
        (NULLIF(trim("Category"), '') IS NULL) +
        (NULLIF(trim("Sub Category"), '') IS NULL) +
        (NULLIF(trim("City"), '') IS NULL) +
        (NULLIF(trim("Order Date"), '') IS NULL) +
        (NULLIF(trim("Region"), '') IS NULL) +
        ("Sales" IS NULL) +
        ("Discount" IS NULL) +
        ("Profit" IS NULL) +
        (NULLIF(trim("State"), '') IS NULL)
    )
FROM normalized_sales;

.output stdout
