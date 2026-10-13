declare const amount: string;
declare const total: string;
declare const unitPrice: string;
declare const invoice: { totalAmount: string };

export const a = parseFloat(amount);
export const b = Number(total);
export const c = Number.parseFloat(unitPrice);
export const d = parseInt(amount, 10);
export const e = Number.parseInt(unitPrice, 10);
export const f = Number(invoice.totalAmount);
