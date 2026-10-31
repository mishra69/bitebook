import { describe, expect, it } from "vitest";
import { replyText } from "../../src/worker/openrouter";

describe("reading an OpenRouter reply", () => {
  it("returns the reply text", () => {
    expect(replyText(200, true, { choices: [{ message: { content: "{}" }, finish_reason: "stop" }] })).toBe("{}");
  });
  it("names a reply cut off at max_tokens (D42)", () => {
    expect(() => replyText(200, true, { choices: [{ message: { content: '{"meals": [' }, finish_reason: "length" }] })).toThrow(
      "reply cut off at max_tokens",
    );
  });
  it("passes on OpenRouter's own error, such as running out of credits", () => {
    expect(() => replyText(402, false, { error: { message: "This request's maximum cost exceeds your available credits." } })).toThrow(
      "openrouter 402: This request's maximum cost exceeds your available credits.",
    );
  });
});
