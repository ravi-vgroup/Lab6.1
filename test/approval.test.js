import test from "node:test";
import assert from "node:assert/strict";

import { requireApproval } from "../src/approval.js";
import {
  pickProductMatch,
  pickLocationMatch,
} from "../src/tools.js";


// ============================================================
// Approval Gate Tests — 5 cases
// ============================================================

test("shopper + confirmed is rejected", () => {
  assert.throws(
    () =>
      requireApproval({
        role: "shopper",
        confirmed: true,
      }),
    /must be admin or staff/
  );
});

test("admin + not confirmed is rejected", () => {
  assert.throws(
    () =>
      requireApproval({
        role: "admin",
        confirmed: false,
      }),
    /explicit confirmation is required/
  );
});

test("staff + not confirmed is rejected", () => {
  assert.throws(
    () =>
      requireApproval({
        role: "staff",
        confirmed: false,
      }),
    /explicit confirmation is required/
  );
});

test("admin + confirmed passes", () => {
  assert.equal(
    requireApproval({
      role: "admin",
      confirmed: true,
    }),
    true
  );
});

test("staff + confirmed passes", () => {
  assert.equal(
    requireApproval({
      role: "staff",
      confirmed: true,
    }),
    true
  );
});


// ============================================================
// Product Name Matching Tests — 4 cases
// ============================================================

test("product exact match wins", () => {
  const products = [
    { id: "1", title: "Snowboard" },
    { id: "2", title: "Snowboard Boots" },
  ];

  const result = pickProductMatch(products, "Snowboard");

  assert.equal(result.id, "1");
});

test("product substring match works when there is one match", () => {
  const products = [
    { id: "1", title: "Snowboard" },
    { id: "2", title: "T-Shirt" },
  ];

  const result = pickProductMatch(products, "snow");

  assert.equal(result.id, "1");
});

test("product with no match is rejected", () => {
  const products = [
    { id: "1", title: "Snowboard" },
    { id: "2", title: "T-Shirt" },
  ];

  assert.throws(
    () => pickProductMatch(products, "Laptop"),
    /No product found/
  );
});

test("ambiguous product match is rejected", () => {
  const products = [
    { id: "1", title: "Snowboard Red" },
    { id: "2", title: "Snowboard Blue" },
  ];

  assert.throws(
    () => pickProductMatch(products, "Snowboard"),
    /Multiple products found/
  );
});


// ============================================================
// Location Name Matching Tests — 4 cases
// ============================================================

test("location exact match wins", () => {
  const locations = [
    { id: "1", name: "Warehouse" },
    { id: "2", name: "Warehouse East" },
  ];

  const result = pickLocationMatch(locations, "Warehouse");

  assert.equal(result.id, "1");
});

test("location substring match works when there is one match", () => {
  const locations = [
    { id: "1", name: "Main Warehouse" },
    { id: "2", name: "Store" },
  ];

  const result = pickLocationMatch(locations, "Main");

  assert.equal(result.id, "1");
});

test("location with no match is rejected", () => {
  const locations = [
    { id: "1", name: "Warehouse" },
    { id: "2", name: "Store" },
  ];

  assert.throws(
    () => pickLocationMatch(locations, "Office"),
    /No location found/
  );
});

test("ambiguous location match is rejected", () => {
  const locations = [
    { id: "1", name: "Warehouse East" },
    { id: "2", name: "Warehouse West" },
  ];

  assert.throws(
    () => pickLocationMatch(locations, "Warehouse"),
    /Multiple locations found/
  );
});