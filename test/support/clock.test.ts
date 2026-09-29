import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TestClock, asEpochMs, frozenClock } from "./clock.ts";

describe("clock", () => {
  it("advance は前に進む", () => {
    const clock = new TestClock(1000);
    assert.equal(clock.now(), 1000);
    assert.equal(clock.advance(500), 1500);
  });

  it("advance に負値を渡せない（巻き戻しは意図を名前で残す）", () => {
    assert.throws(() => new TestClock(1000).advance(-1), /rewindTo/);
  });

  it("rewindTo で過去に戻せる（#14 / #19 の再現用）", () => {
    const clock = new TestClock(1000);
    clock.advance(500);
    assert.equal(clock.rewindTo(800), 800);
  });

  it("rewindTo は前に進めない", () => {
    assert.throws(() => new TestClock(1000).rewindTo(2000), /Use advance/);
  });

  it("ストアとワーカーは独立した時計を持てる（#14）", () => {
    const store = new TestClock(1000);
    const worker = new TestClock(1000);
    worker.rewindTo(400);
    assert.equal(store.now(), 1000);
    assert.equal(worker.now(), 400);
  });

  it("EpochMs は整数のみ。小数と ISO 文字列由来の値を弾く", () => {
    assert.throws(() => asEpochMs(1.5), /safe integer/);
    assert.throws(() => asEpochMs(Number.NaN), /safe integer/);
  });

  it("frozenClock は動かない", () => {
    const clock = frozenClock(42);
    assert.equal(clock.now(), 42);
    assert.equal(clock.now(), 42);
  });
});
