# Fonts

Gravity Forge uses a system font stack for maximum compatibility and
zero-download startup:

    "Segoe UI", system-ui, -apple-system, "Helvetica Neue", Arial, sans-serif

To use a custom webfont, drop the font files (woff2/woff) in this folder,
declare them with `@font-face` in `style.css`, and add the family to the
`--font` CSS variable.
