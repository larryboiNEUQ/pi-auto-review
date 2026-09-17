import { describe, expect, it, vi } from "vitest";
import { evaluateJev, JEV_QUESTIONS, JEV_CONTRACT_VERSION } from "../src/jev-evaluation";

const sdk = vi.hoisted(() => ({ evaluate: vi.fn(), evaluationModel: vi.fn(), gateway: vi.fn() }));
vi.mock("ai", () => ({ experimental_evaluate: sdk.evaluate, createGateway: sdk.gateway }));

describe("pinned Jev evaluation contract", () => {
  it("pins trusted questions and choices for the versioned Guardian contract", () => {
    expect({ version: JEV_CONTRACT_VERSION, questions: JEV_QUESTIONS }).toMatchSnapshot();
  });
  it("uses Gateway evaluation transport with no nested retries and forwards cancellation", async () => {
    const model = { specificationVersion: "v4", provider: "gateway", modelId: "typesafe-ai/jev" };
    sdk.gateway.mockReturnValue({ evaluationModel: sdk.evaluationModel });
    sdk.evaluationModel.mockReturnValue(model);
    sdk.evaluate.mockResolvedValue({ answers: {} });
    const signal = new AbortController().signal;
    await evaluateJev({ apiKey: "synthetic-key", state: "harmless synthetic fixture", questions: JEV_QUESTIONS, signal });
    expect(sdk.gateway).toHaveBeenCalledWith({ apiKey: "synthetic-key" });
    expect(sdk.evaluationModel).toHaveBeenCalledWith("typesafe-ai/jev");
    expect(sdk.evaluate).toHaveBeenCalledWith({ model, state: "harmless synthetic fixture", questions: JEV_QUESTIONS, maxRetries: 0, abortSignal: signal });
  });
});
