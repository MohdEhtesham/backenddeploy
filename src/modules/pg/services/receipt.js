const { escapeHtml } = require('../../notifications/dispatcher');
const { formatINR } = require('./format');
const D = require('../../core/dates');

const METHOD_LABEL = {
  CASH: 'Cash',
  UPI: 'UPI',
  BANK_TRANSFER: 'Bank transfer',
  CARD: 'Card',
  ONLINE: 'Online (gateway)',
  DEPOSIT_ADJUSTMENT: 'Security deposit adjustment',
};

/** Printable, self-contained HTML receipt (no scripts, no external assets). */
const receiptHtml = ({ org, property, tenant, payment, invoices }) => {
  const e = escapeHtml;
  const rows = (payment.allocations || [])
    .map(a => {
      const inv = invoices.find(i => i._id === a.invoiceId) || {};
      return `<tr><td>${e(inv.invoiceNumber || '')}</td><td>${e(inv.kind || '')}${inv.periodKey ? ` · ${e(inv.periodKey)}` : ''}</td><td class="r">${e(formatINR(a.amount))}</td></tr>`;
    })
    .join('');
  const unapplied = payment.unappliedAmount > 0
    ? `<tr><td colspan="2">Advance credit</td><td class="r">${e(formatINR(payment.unappliedAmount))}</td></tr>`
    : '';
  const addr = org.address || {};
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Receipt ${e(payment.receiptNumber || '')}</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#111827;margin:0;background:#f3f4f6}
.card{max-width:640px;margin:24px auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 8px 24px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0}.muted{color:#6b7280;font-size:13px}.amt{font-size:34px;font-weight:800;color:#1E3A8A;margin:18px 0 4px}
.badge{display:inline-block;background:#10B98120;color:#047857;font-weight:700;font-size:12px;padding:4px 10px;border-radius:999px}
table{width:100%;border-collapse:collapse;margin-top:18px;font-size:14px}th,td{padding:10px 6px;border-bottom:1px solid #e5e7eb;text-align:left}
.r{text-align:right}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:18px;font-size:14px}
.grid div span{display:block;color:#6b7280;font-size:12px}
@media print{body{background:#fff}.card{box-shadow:none;margin:0}}
</style></head><body><div class="card">
<h1>${e(org.name)}</h1>
<div class="muted">${e([property && property.name, addr.city, addr.state].filter(Boolean).join(' · '))}${org.gstin ? ` · GSTIN ${e(org.gstin)}` : ''}</div>
<div class="amt">${e(formatINR(payment.amount))}</div>
<span class="badge">PAYMENT RECEIVED</span>
<div class="grid">
<div><span>Receipt no.</span>${e(payment.receiptNumber || '')}</div>
<div><span>Date</span>${e(payment.paidAt ? D.dayKey(payment.paidAt) : '')}</div>
<div><span>Received from</span>${e(tenant ? tenant.fullName : '')}</div>
<div><span>Method</span>${e(METHOD_LABEL[payment.method] || payment.method)}</div>
${payment.reference || (payment.gateway && payment.gateway.paymentId) ? `<div><span>Reference</span>${e(payment.reference || payment.gateway.paymentId)}</div>` : ''}
</div>
<table><thead><tr><th>Invoice</th><th>For</th><th class="r">Amount</th></tr></thead><tbody>${rows}${unapplied}</tbody></table>
<p class="muted" style="margin-top:22px">This is a computer-generated receipt and does not require a signature.</p>
</div></body></html>`;
};

module.exports = { receiptHtml, METHOD_LABEL };
