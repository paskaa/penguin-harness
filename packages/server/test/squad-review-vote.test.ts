/**
 * Squad review-vote config helpers: the switch off a parsed config.json, and the
 * file's new text with only the switch flipped.
 */
import { describe, expect, it } from "vitest";
import {
  parseReviewVoteFlag,
  renderSquadConfig,
  SQUAD_VOTE_KEY,
} from "../src/http/routes/squad.js";

describe("parseReviewVoteFlag", () => {
  it("opens only on an explicit true", () => {
    expect(parseReviewVoteFlag({ [SQUAD_VOTE_KEY]: true })).toBe(true);
  });
  it("stays human on anything else", () => {
    expect(parseReviewVoteFlag({})).toBe(false);
    expect(parseReviewVoteFlag({ [SQUAD_VOTE_KEY]: false })).toBe(false);
    expect(parseReviewVoteFlag({ [SQUAD_VOTE_KEY]: "true" })).toBe(false);
    expect(parseReviewVoteFlag(null)).toBe(false);
    expect(parseReviewVoteFlag(undefined)).toBe(false);
    expect(parseReviewVoteFlag("review_vote")).toBe(false);
  });
});

describe("renderSquadConfig", () => {
  it("flips only the switch and keeps the other keys", () => {
    const out = JSON.parse(
      renderSquadConfig({ _note: "n", [SQUAD_VOTE_KEY]: false }, true),
    ) as Record<string, unknown>;
    expect(out).toEqual({ _note: "n", [SQUAD_VOTE_KEY]: true });
  });
  it("starts from an empty object when the file was missing or invalid", () => {
    expect(JSON.parse(renderSquadConfig(null, true))).toEqual({
      [SQUAD_VOTE_KEY]: true,
    });
    expect(JSON.parse(renderSquadConfig("garbage", false))).toEqual({
      [SQUAD_VOTE_KEY]: false,
    });
  });
});
