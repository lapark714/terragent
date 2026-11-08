import { describe, expect, it } from "vitest";
import { mockReportPdf, wrap } from "./mockPdf";

describe("mockReportPdf", () => {
  it("builds a well-formed PDF with a correct xref offset and escaped, ASCII-only text", () => {
    const pdf = mockReportPdf("Report (draft)", ["Café at 50% \\ done"]);
    expect(pdf.startsWith("%PDF-1.4")).toBe(true);
    expect(pdf.trimEnd().endsWith("%%EOF")).toBe(true);
    const xref = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    expect(pdf).toContain("Report \\(draft\\)");
    expect(pdf).toContain("Cafe at 50% \\\\ done");
    expect(pdf).toContain("MOCK REPORT");
  });
  it("wraps text on spaces", () => {
    expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  });
});
