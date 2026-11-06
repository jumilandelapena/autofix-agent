import { describe, expect, it } from "vitest";
import { applyDiscount, formatMoney, paginate, parseIntParam, round2, slugify } from "../src/utils.js";

describe("utils", () => {
  it("slugifies simple names", () => {
    expect(slugify("Desk Lamp")).toBe("desk-lamp");
    expect(slugify("USB-C Cable")).toBe("usb-c-cable");
  });

  it("applies a zero discount", () => {
    expect(applyDiscount(100, 0)).toBe(100);
  });

  it("rejects discounts outside 0-100", () => {
    expect(() => applyDiscount(100, 101)).toThrow(RangeError);
    expect(() => applyDiscount(100, -5)).toThrow(RangeError);
  });

  it("returns everything when the limit is larger than the list", () => {
    expect(paginate([1, 2, 3, 4, 5], 0, 20)).toEqual([1, 2, 3, 4, 5]);
  });

  it("formats money with two decimals", () => {
    expect(formatMoney(4.5)).toBe("$4.50");
    expect(formatMoney(399)).toBe("$399.00");
  });

  it("rounds to cents", () => {
    expect(round2(0.1 + 0.2)).toBe(0.3);
    expect(round2(1.005)).toBe(1.01);
  });

  it("parses integer query params with a fallback", () => {
    expect(parseIntParam("7", 1)).toBe(7);
    expect(parseIntParam(undefined, 1)).toBe(1);
    expect(parseIntParam("abc", 1)).toBe(1);
    expect(parseIntParam("-3", 1)).toBe(1);
  });
});
