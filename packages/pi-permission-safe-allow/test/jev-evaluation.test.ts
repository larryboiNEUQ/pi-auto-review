import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateJev,
  evaluateJevViaOfficial,
  JEV_QUESTIONS,
  JEV_CONTRACT_VERSION,
  JEV_OFFICIAL_ENDPOINT,
  JEV_OFFICIAL_DEFAULT_MODEL,
  JevEvaluationError,
  parseJevDecision,
  resolveJevTransport,
} from "../src/jev-evaluation";

const sdk = vi.hoisted(() => ({ evaluate: vi.fn(), evaluationModel: vi.fn(), gateway: vi.fn() }));
vi.mock("ai", () => ({ experimental_evaluate: sdk.evaluate, createGateway: sdk.gateway }));

afterEach(() => {
  delete process.env.TYPESAFE_API_KEY;
  delete process.env.SAFE_ALLOW_JEV_TRANSPORT;
  delete process.env.TYPESAFE_JEV_MODEL;
  vi.unstubAllGlobals();
  sdk.evaluate.mockReset();
  sdk.evaluationModel.mockReset();
  sdk.gateway.mockReset();
});

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
    await evaluateJev({
      apiKey: "synthetic-key",
      state: "harmless synthetic fixture",
      questions: JEV_QUESTIONS,
      signal,
      transport: "gateway",
    });
    expect(sdk.gateway).toHaveBeenCalledWith({ apiKey: "synthetic-key" });
    expect(sdk.evaluationModel).toHaveBeenCalledWith("typesafe-ai/jev");
    expect(sdk.evaluate).toHaveBeenCalledWith({
      model,
      state: "harmless synthetic fixture",
      questions: JEV_QUESTIONS,
      maxRetries: 0,
      abortSignal: signal,
    });
  });
});

describe("Jev transport selection", () => {
  it("auto-selects official when TYPESAFE_API_KEY is set", () => {
    expect(resolveJevTransport({ TYPESAFE_API_KEY: " ts-key " })).toEqual({
      transport: "official",
      typesafeApiKey: "ts-key",
    });
  });
  it("auto-selects gateway when TYPESAFE_API_KEY is absent", () => {
    expect(resolveJevTransport({})).toEqual({ transport: "gateway", typesafeApiKey: undefined });
  });
  it("honors SAFE_ALLOW_JEV_TRANSPORT=gateway even when a TypeSafe key exists", () => {
    expect(
      resolveJevTransport({ TYPESAFE_API_KEY: "ts-key", SAFE_ALLOW_JEV_TRANSPORT: "gateway" }),
    ).toEqual({ transport: "gateway", typesafeApiKey: "ts-key" });
  });
  it("honors SAFE_ALLOW_JEV_TRANSPORT=official and still surfaces the key", () => {
    expect(
      resolveJevTransport({ SAFE_ALLOW_JEV_TRANSPORT: "official", TYPESAFE_API_KEY: "ts-key" }),
    ).toEqual({ transport: "official", typesafeApiKey: "ts-key" });
  });
});

describe("official TypeSafe HTTP transport", () => {
  function validAnswers() {
    return Object.fromEntries(
      Object.entries(JEV_QUESTIONS).map(([id, question]) => {
        const choice = Object.keys(question.criteria)[0]!;
        const probabilities = Object.fromEntries(
          Object.keys(question.criteria).map((key) => [key, key === choice ? 1 : 0]),
        );
        return [id, { type: "choice", choice, confidence: 1, probabilities }];
      }),
    );
  }

  it("POSTs to api.typesafe.ai with Bearer auth and parses answers via parseJevDecision", async () => {
    const fetchImpl = vi.fn(async () =>
      Response.json({
        model: "jev-1.13.0",
        answers: validAnswers(),
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
    );
    const signal = new AbortController().signal;
    const result = await evaluateJevViaOfficial({
      apiKey: "ts-key",
      state: "harmless synthetic fixture",
      questions: JEV_QUESTIONS,
      signal,
      officialModel: "jev-1.13.0",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(JEV_OFFICIAL_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.signal).toBe(signal);
    expect(init.headers).toEqual(
      expect.objectContaining({
        Authorization: "Bearer ts-key",
        "Content-Type": "application/json",
      }),
    );
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: "jev-1.13.0",
      state: "harmless synthetic fixture",
      questions: JEV_QUESTIONS,
    });
    const decision = parseJevDecision(result);
    expect(decision?.verdict).toBe("allow");
    expect(decision?.riskLevel).toBe("low");
  });

  it("defaults official model to jev-latest", async () => {
    const fetchImpl = vi.fn(async () => Response.json({ model: JEV_OFFICIAL_DEFAULT_MODEL, answers: validAnswers() }));
    await evaluateJev({
      apiKey: "ts-key",
      state: "state",
      questions: JEV_QUESTIONS,
      signal: new AbortController().signal,
      transport: "official",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe(JEV_OFFICIAL_DEFAULT_MODEL);
  });

  it("fail-closes on HTTP auth errors without falling back to Gateway", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 401 }));
    await expect(
      evaluateJevViaOfficial({
        apiKey: "bad",
        state: "state",
        questions: JEV_QUESTIONS,
        signal: new AbortController().signal,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      name: "JevEvaluationError",
      code: "transport",
      message: expect.stringContaining("HTTP 401"),
    });
    expect(sdk.gateway).not.toHaveBeenCalled();
  });

  it("fail-closes on non-JSON success bodies as parse errors", async () => {
    const fetchImpl = vi.fn(async () => new Response("not-json", { status: 200, headers: { "Content-Type": "text/plain" } }));
    await expect(
      evaluateJevViaOfficial({
        apiKey: "ts-key",
        state: "state",
        questions: JEV_QUESTIONS,
        signal: new AbortController().signal,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(JevEvaluationError);
  });

  it("propagates abort without classifying as a generic transport failure", async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => {
      controller.abort();
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    });
    await expect(
      evaluateJevViaOfficial({
        apiKey: "ts-key",
        state: "state",
        questions: JEV_QUESTIONS,
        signal: controller.signal,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
