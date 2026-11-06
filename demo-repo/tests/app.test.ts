import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";

describe("inventory api", () => {
  it("reports health", async () => {
    const res = await request(createApp()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it("lists the seeded items", async () => {
    const res = await request(createApp()).get("/items");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(5);
    expect(res.body.items).toHaveLength(5);
    expect(res.body.items[0].name).toBe("Desk Lamp");
  });

  it("filters by name", async () => {
    const res = await request(createApp()).get("/items").query({ q: "Desk" });
    expect(res.status).toBe(200);
    expect(res.body.items.map((i: { name: string }) => i.name)).toEqual(["Desk Lamp", "Standing Desk"]);
  });

  it("returns one item by id", async () => {
    const res = await request(createApp()).get("/items/1");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Desk Lamp");
    expect(res.body.slug).toBe("desk-lamp");
  });

  it("returns 404 for an unknown item", async () => {
    const res = await request(createApp()).get("/items/999");
    expect(res.status).toBe(404);
  });

  it("creates an item with a slug", async () => {
    const app = createApp();
    const res = await request(app).post("/items").send({ name: "Wireless Mouse", price: 29.9, quantity: 15, tags: ["electronics"] });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe(6);
    expect(res.body.slug).toBe("wireless-mouse");
    const list = await request(app).get("/items");
    expect(list.body.total).toBe(6);
  });

  it("rejects invalid input", async () => {
    const res = await request(createApp()).post("/items").send({ name: "", price: -1, quantity: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/name/);
  });

  it("deletes an existing item", async () => {
    const app = createApp();
    const del = await request(app).delete("/items/2");
    expect(del.status).toBe(204);
    const after = await request(app).get("/items/2");
    expect(after.status).toBe(404);
  });

  it("returns the full price without a discount", async () => {
    const res = await request(createApp()).get("/items/3/price");
    expect(res.status).toBe(200);
    expect(res.body.price).toBe(4.5);
    expect(res.body.formatted).toBe("$4.50");
  });
});
