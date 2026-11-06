import express, { type Request, type Response } from "express";
import { ItemStore, type NewItem } from "./store.js";
import { applyDiscount, formatMoney, paginate, parseIntParam } from "./utils.js";

export const DEFAULT_LIMIT = 20;

function parseItemInput(body: unknown, partial: boolean): { ok: true; value: Partial<NewItem> } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "body must be a JSON object" };
  const b = body as Record<string, unknown>;
  const value: Partial<NewItem> = {};
  if ("name" in b || !partial) {
    if (typeof b["name"] !== "string" || b["name"].trim() === "") return { ok: false, error: "name must be a non-empty string" };
    value.name = b["name"].trim();
  }
  if ("price" in b || !partial) {
    if (typeof b["price"] !== "number" || !Number.isFinite(b["price"]) || b["price"] < 0) return { ok: false, error: "price must be a non-negative number" };
    value.price = b["price"];
  }
  if ("quantity" in b || !partial) {
    if (typeof b["quantity"] !== "number" || !Number.isInteger(b["quantity"]) || b["quantity"] < 0) return { ok: false, error: "quantity must be a non-negative integer" };
    value.quantity = b["quantity"];
  }
  if ("tags" in b) {
    if (!Array.isArray(b["tags"]) || !b["tags"].every((t) => typeof t === "string")) return { ok: false, error: "tags must be an array of strings" };
    value.tags = b["tags"] as string[];
  }
  return { ok: true, value };
}

function idParam(req: Request): number | null {
  const id = Number(req.params["id"]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function createApp(store: ItemStore = new ItemStore()) {
  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  // GET /items?q=<text>&offset=<n>&limit=<n>
  app.get("/items", (req, res) => {
    const q = typeof req.query["q"] === "string" ? req.query["q"] : "";
    const offset = parseIntParam(req.query["offset"], 0);
    const limit = parseIntParam(req.query["limit"], DEFAULT_LIMIT);
    const matches = q ? store.search(q) : store.list();
    res.json({ total: matches.length, offset, limit, items: paginate(matches, offset, limit) });
  });

  app.get("/items/:id", (req, res) => {
    const id = idParam(req);
    const item = id === null ? undefined : store.get(id);
    if (!item) return void res.status(404).json({ error: "item not found" });
    res.json(item);
  });

  // GET /items/:id/price?discount=<percent>
  app.get("/items/:id/price", (req, res) => {
    const id = idParam(req);
    const item = id === null ? undefined : store.get(id);
    if (!item) return void res.status(404).json({ error: "item not found" });
    const discount = parseIntParam(req.query["discount"], 0);
    if (discount > 100) return void res.status(400).json({ error: "discount must be between 0 and 100" });
    const price = applyDiscount(item.price, discount);
    res.json({ id: item.id, price, formatted: formatMoney(price), discount });
  });

  app.post("/items", (req, res) => {
    const parsed = parseItemInput(req.body, false);
    if (!parsed.ok) return void res.status(400).json({ error: parsed.error });
    const item = store.create(parsed.value as NewItem);
    res.status(201).json(item);
  });

  app.put("/items/:id", (req, res) => {
    const id = idParam(req);
    if (id === null) return void res.status(404).json({ error: "item not found" });
    const parsed = parseItemInput(req.body, true);
    if (!parsed.ok) return void res.status(400).json({ error: parsed.error });
    const item = store.update(id, parsed.value);
    if (!item) return void res.status(404).json({ error: "item not found" });
    res.json(item);
  });

  app.delete("/items/:id", (req, res) => {
    const id = idParam(req);
    if (id === null) return void res.status(404).json({ error: "item not found" });
    const removed = store.remove(id);
    if (!removed) return void res.status(404).json({ error: "item not found" });
    res.status(204).end();
  });

  app.use((_req, res: Response) => {
    res.status(404).json({ error: "route not found" });
  });

  return app;
}
