import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { proxy } from "./proxy";

/** R6 of the OCL-224 review, fixed in OCL-227. */
describe("invite proxy", () => {
  it("sends a link with a malformed escape to the invalid-invite page", () => {
    for (const token of ["abc%", "abc%zz", "%E0%A4%A"]) {
      const res = proxy(new NextRequest(`http://board.test/invite/${token}`));
      expect(res.status).toBe(307);
      expect(new URL(res.headers.get("location")!).pathname).toBe("/invite/invalid");
    }
  });

  it("lets a well-formed link through untouched", () => {
    for (const token of ["Q2x2ZXI", "abc%25", "naoexiste"]) {
      const res = proxy(new NextRequest(`http://board.test/invite/${token}`));
      expect(res.headers.get("location")).toBeNull();
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });
});
