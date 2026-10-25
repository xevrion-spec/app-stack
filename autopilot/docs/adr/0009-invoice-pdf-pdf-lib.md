# ADR 0009: Invoice PDFs rendered with pdf-lib in the Worker
Status: accepted (2026-10-25)

pdf-lib is pure JavaScript (no native code, no headless browser), runs in Workers, and only uses the standard Helvetica fonts, so text is sanitised to WinAnsi. PDFs are rendered on request and not stored. Limits: no logo or custom fonts yet; non-Latin characters are replaced with "?".
