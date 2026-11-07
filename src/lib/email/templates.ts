/**
 * OWNER: email builder. Every customer/supplier/outreach email body is rendered here so the
 * compliance pieces (sender identity, AI disclosure, opt-out for outreach, CAN-SPAM postal line) are never forgotten.
 */
export interface RenderedEmail { subject: string; text: string; html: string }

export interface ReportForEmail {
  id: string; title: string; answer: string; confidence: "high" | "medium" | "low"; limitations: string;
  human_review_recommended: boolean; url: string;
  images: { role: string; url: string; caption: string }[];
  measurements: { metric: string; value: number | null; unit: string | null; note?: string | null }[];
  sources: { name: string; datetime: string | null }[];
}

export function renderReportDelivery(a: { customerName?: string | null; question: string; report: ReportForEmail; paymentLink?: string | null; priceUsd?: number | null }): RenderedEmail { throw new Error("not implemented yet"); }
export function renderQuote(a: { customerName?: string | null; question: string; quote: { price_usd: number; line_items: { label: string; amount_usd: number }[]; auto_approved: boolean }; paymentLink?: string | null; requestId: string }): RenderedEmail { throw new Error("not implemented yet"); }
export function renderClarifyingQuestion(a: { customerName?: string | null; question: string; clarifyingQuestion: string }): RenderedEmail { throw new Error("not implemented yet"); }
export function renderRefusal(a: { customerName?: string | null; reason: string }): RenderedEmail { throw new Error("not implemented yet"); }
export function renderSupplierQuoteRequest(a: { providerName: string; product: string; aoiDescription: string; areaKm2: number | null; dateWindow: string; orderId: string }): RenderedEmail { throw new Error("not implemented yet"); }
export function renderOutreach(a: { template: { subject: string; body: string }; vars: Record<string, string>; report: ReportForEmail; optOutUrl: string }): RenderedEmail { throw new Error("not implemented yet"); }
export function renderFollowup(a: { contactName?: string | null; company: string; newInfo: string; report: ReportForEmail; optOutUrl: string }): RenderedEmail { throw new Error("not implemented yet"); }
