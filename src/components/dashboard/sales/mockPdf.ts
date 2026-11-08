/**
 * A one-page MOCK PDF built in the browser for the "Download PDF" link on delivered reports. It is a placeholder
 * until the real report export exists: every page says MOCK, and it carries only what the dashboard already shows.
 */

/** PDF text strings: ASCII only, with backslashes and parentheses escaped. */
function pdfText(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[^\x20-\x7e]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

/** Splits text into lines of at most `width` characters, on spaces. */
export function wrap(text: string, width = 88): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && (line + " " + word).length > width) {
      out.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
}

/** Builds the PDF bytes: a title, a MOCK banner, and body lines in Helvetica on US Letter. */
export function mockReportPdf(title: string, lines: string[]): string {
  const body = [
    "BT /F2 20 Tf 56 730 Td (" + pdfText(title) + ") Tj ET",
    "BT /F2 11 Tf 56 706 Td (MOCK REPORT - placeholder for the real export, not a deliverable) Tj ET",
    "BT /F1 11 Tf 56 680 Td 15 TL",
    ...lines.slice(0, 40).map((l) => "(" + pdfText(l) + ") Tj T*"),
    "ET",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
    `<< /Length ${body.length} >>\nstream\n${body}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return pdf;
}

/** Starts a browser download of the mock PDF. */
export function downloadMockPdf(filename: string, title: string, lines: string[]) {
  const blob = new Blob([mockReportPdf(title, lines)], { type: "application/pdf" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
