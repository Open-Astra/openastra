import { z } from "zod";
import type { SkillDefinition } from "../../types.js";
import type { PluginContext } from "../../../plugins/types.js";

// ── Invoice Generator Skill ─────────────────────────────────────────
// Creates structured invoices from line items. Outputs JSON invoice
// data and optional HTML for PDF rendering.

const LineItemSchema = z.object({
  description: z.string().describe("Line item description"),
  quantity: z.number().positive().describe("Quantity"),
  unitPrice: z.number().nonnegative().describe("Price per unit"),
  taxRate: z.number().min(0).max(1).default(0).describe("Tax rate (0-1, e.g. 0.08 for 8%)"),
});

const CreateInvoiceParams = z.object({
  invoiceNumber: z.string().describe("Invoice number (e.g. INV-2026-001)"),
  from: z.object({
    name: z.string(),
    address: z.string().optional(),
    email: z.string().optional(),
  }).describe("Seller/from details"),
  to: z.object({
    name: z.string(),
    address: z.string().optional(),
    email: z.string().optional(),
  }).describe("Buyer/to details"),
  items: z.array(LineItemSchema).min(1).max(50).describe("Line items"),
  currency: z.string().default("USD").describe("Currency code"),
  notes: z.string().optional().describe("Additional notes"),
  dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
});

const invoiceGeneratorSkill: SkillDefinition = {
  name: "invoice_generator",
  version: "1.0.0",

  manifest: {
    id: "invoice_generator",
    name: "Invoice Generator",
    description: "Create structured invoices with line items, tax calculations, and HTML output for PDF rendering.",
    category: "transform",
    tools: ["invoice_create"],
    configFields: [],
    version: "1.0.0",
  },

  init(ctx: PluginContext) {
    ctx.registerTool({
      name: "invoice_create",
      description: "Create an invoice from line items. Calculates subtotal, tax, and total. Returns structured data and HTML.",
      parameters: CreateInvoiceParams,

      async execute(params) {
        const items = params.items.map((item) => {
          const subtotal = item.quantity * item.unitPrice;
          const tax = subtotal * item.taxRate;
          return { ...item, subtotal, tax, total: subtotal + tax };
        });

        const subtotal = items.reduce((sum, i) => sum + i.subtotal, 0);
        const totalTax = items.reduce((sum, i) => sum + i.tax, 0);
        const total = subtotal + totalTax;

        const invoice = {
          invoiceNumber: params.invoiceNumber,
          date: new Date().toISOString().slice(0, 10),
          dueDate: params.dueDate ?? null,
          currency: params.currency,
          from: params.from,
          to: params.to,
          items,
          subtotal: Math.round(subtotal * 100) / 100,
          tax: Math.round(totalTax * 100) / 100,
          total: Math.round(total * 100) / 100,
          notes: params.notes ?? null,
        };

        // Generate simple HTML
        const itemRows = items.map((i) =>
          `<tr><td>${i.description}</td><td>${i.quantity}</td><td>${params.currency} ${i.unitPrice.toFixed(2)}</td><td>${(i.taxRate * 100).toFixed(0)}%</td><td>${params.currency} ${i.total.toFixed(2)}</td></tr>`,
        ).join("\n");

        const html = `<!DOCTYPE html><html><head><style>
body{font-family:sans-serif;padding:40px}table{width:100%;border-collapse:collapse;margin:20px 0}
th,td{border:1px solid #ddd;padding:8px;text-align:left}th{background:#f5f5f5}
.total{font-size:1.2em;font-weight:bold}.header{display:flex;justify-content:space-between}
</style></head><body>
<div class="header"><div><h1>Invoice ${invoice.invoiceNumber}</h1><p>Date: ${invoice.date}</p>${invoice.dueDate ? `<p>Due: ${invoice.dueDate}</p>` : ""}</div></div>
<div style="display:flex;gap:40px"><div><h3>From</h3><p>${invoice.from.name}<br>${invoice.from.address ?? ""}${invoice.from.email ? `<br>${invoice.from.email}` : ""}</p></div>
<div><h3>To</h3><p>${invoice.to.name}<br>${invoice.to.address ?? ""}${invoice.to.email ? `<br>${invoice.to.email}` : ""}</p></div></div>
<table><thead><tr><th>Description</th><th>Qty</th><th>Unit Price</th><th>Tax</th><th>Total</th></tr></thead><tbody>${itemRows}</tbody></table>
<p>Subtotal: ${params.currency} ${invoice.subtotal.toFixed(2)}</p><p>Tax: ${params.currency} ${invoice.tax.toFixed(2)}</p>
<p class="total">Total: ${params.currency} ${invoice.total.toFixed(2)}</p>
${invoice.notes ? `<p><em>${invoice.notes}</em></p>` : ""}
</body></html>`;

        return { invoice, html };
      },
    });
  },

  getPromptContext() {
    return {
      skillId: "invoice_generator",
      instructions: "You can create invoices with `invoice_create`. Provide seller/buyer info and line items. Returns structured JSON and HTML for PDF rendering.",
    };
  },
};

export default invoiceGeneratorSkill;
