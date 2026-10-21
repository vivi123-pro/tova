import { Prisma } from "./generated/prisma/client.js";
export class ValidationError extends Error {
}
export class IdempotencyConflict extends Error {
}
const MAX_AMOUNT = new Prisma.Decimal("999999999999.99");
function object(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ValidationError("Expected a JSON object.");
    }
    return value;
}
function keys(value, allowed) {
    if (Object.keys(value).some(key => !allowed.includes(key))) {
        throw new ValidationError("Request contains unsupported fields.");
    }
}
function text(value, field, limit) {
    if (typeof value !== "string" || !value.trim() || value.trim().length > limit) {
        throw new ValidationError(`${field} must contain 1–${limit} characters.`);
    }
    return value.trim();
}
function integer(value, field) {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 2147483647) {
        throw new ValidationError(`${field} must be a positive 32-bit integer.`);
    }
    return value;
}
export function prepareSale(input) {
    const body = object(input);
    keys(body, ["items"]);
    if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
        throw new ValidationError("items must contain between 1 and 100 items.");
    }
    const items = body.items.map((value, index) => {
        const item = object(value);
        keys(item, ["name", "quantity", "unit", "piecesPerUnit", "unitPrice"]);
        const field = `items[${index}]`;
        const name = text(item.name, `${field}.name`, 200);
        const unit = text(item.unit, `${field}.unit`, 50);
        const quantity = integer(item.quantity, `${field}.quantity`);
        const piecesPerUnit = item.piecesPerUnit === undefined ? undefined : integer(item.piecesPerUnit, `${field}.piecesPerUnit`);
        // Decimal strings preserve the caller's exact monetary value.
        if (typeof item.unitPrice !== "string" || !/^\d{1,12}(?:\.\d{1,2})?$/.test(item.unitPrice)) {
            throw new ValidationError(`${field}.unitPrice must be a decimal string with at most two decimal places.`);
        }
        const unitPrice = new Prisma.Decimal(item.unitPrice);
        const lineTotal = unitPrice.mul(quantity);
        if (!unitPrice.gt(0) || lineTotal.gt(MAX_AMOUNT)) {
            throw new ValidationError(`${field} price must be positive and its total must fit Decimal(14,2).`);
        }
        return { name, unit, quantity, piecesPerUnit, unitPrice, lineTotal };
    });
    const totalAmount = items.reduce((total, item) => total.plus(item.lineTotal), new Prisma.Decimal(0));
    if (totalAmount.gt(MAX_AMOUNT))
        throw new ValidationError("Sale total exceeds Decimal(14,2).");
    return { totalAmount, items: { create: items } };
}
function fingerprint(items) {
    return JSON.stringify(items.map(item => JSON.stringify([item.name, item.quantity, item.unit, item.piecesPerUnit ?? null, item.unitPrice.toFixed(2)])).sort());
}
export async function createSale(db, input, key) {
    const data = prepareSale(input);
    if (key !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(key))
        throw new ValidationError("Idempotency-Key must be a UUID v4.");
    const id = key?.toLowerCase();
    // Nested creation is one transaction; no sale survives a failed item insert.
    try {
        return await db.sale.create({ data: { ...data, ...(id ? { id } : {}) }, include: { items: true } });
    }
    catch (error) {
        if (!id || !db.sale.findUnique || !error || typeof error !== "object" || !("code" in error) || error.code !== "P2002")
            throw error;
        // The primary-key constraint serializes concurrent requests. A lost response
        // can be retried with the same key without inserting another sale.
        const existing = await db.sale.findUnique({ where: { id }, include: { items: true } });
        if (!existing)
            throw error;
        if (fingerprint(existing.items) !== fingerprint(data.items.create) || !existing.totalAmount.eq(data.totalAmount))
            throw new IdempotencyConflict("This save key was already used for different sale items.");
        return existing;
    }
}
