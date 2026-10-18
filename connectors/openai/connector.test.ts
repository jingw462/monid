import {
    assert,
    assertAlmostEquals,
    assertEquals,
    assertRejects,
} from "@std/assert";
import { fromFileUrl } from "@std/path";
import type { Json, RunInput, SealedUnit } from "@shared/core";
import {
    estimateEndpoint,
    liveSkip,
    loadFixture,
    runEndpoint,
    testBundle,
    testSealedUnit,
} from "@shared/testing";
import { directTransport, Engine } from "@monid/connector-engine";

const FIXTURES = fromFileUrl(new URL("./fixtures/", import.meta.url));
const MODELS = [
    "gpt-image-2",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-flare",
];
const INPUT = {
    prompt: "a lighthouse at dusk",
    size: "1024x1024",
    quality: "low",
};
const REFERENCES = [
    "https://example.com/first.png",
    "https://example.com/second.jpg",
];
const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=";
const EPSILON = 1e-12;

async function fixture(name = "image-ok") {
    return await loadFixture(`${FIXTURES}synthetic-${name}.json`);
}

async function runBody(unit: SealedUnit, output: Json, status = 200) {
    return await runEndpoint({
        unit,
        input: { body: INPUT },
        mode: "replay",
        fixture: {
            name: "synthetic-response-variant",
            description:
                "Malformed or changed native Images API response envelope.",
            calls: [{
                req: { method: "POST", url: unit.doc.request.url },
                res: { status, body: output },
            }],
        },
    });
}

Deno.test("openai: catalog contains exactly the six public image endpoints", async () => {
    const bundle = await testBundle();
    const ids = Object.keys(bundle.endpoints).filter((id) =>
        id.startsWith("openai#")
    );
    assertEquals(
        ids.sort(),
        MODELS.flatMap((model) => [
            `openai#v1/image/${model}`,
            `openai#v1/image/${model}-edit`,
        ]).sort(),
    );
});

Deno.test("openai: identical receipt and provider lifecycle hooks intern once", async () => {
    const units = await Promise.all(MODELS.flatMap((model) => [
        testSealedUnit(`openai#v1/image/${model}`),
        testSealedUnit(`openai#v1/image/${model}-edit`),
    ]));
    assertEquals(
        new Set(units.map((unit) => JSON.stringify(unit.doc.usage.evidence)))
            .size,
        1,
    );
    assertEquals(
        new Set(units.map((unit) => JSON.stringify(unit.doc.lifecycle?.start)))
            .size,
        1,
    );
});

for (const model of MODELS) {
    for (const edit of [false, true]) {
        const id = `openai#v1/image/${model}${edit ? "-edit" : ""}`;
        const input = { ...INPUT, ...(edit ? { images: REFERENCES } : {}) };

        Deno.test(`${id}: executes native JSON with fixed model, auth and PNG encoding`, async () => {
            const unit = await testSealedUnit(id);
            const response = (await fixture()).calls[0].res;
            const sent: {
                url: string;
                method: string;
                headers: Headers;
                body: unknown;
            }[] = [];
            const loaded = await new Engine({
                transport: directTransport({
                    params: () => Promise.resolve({ apiKey: "test-key" }),
                    fetch: (url, init) => {
                        sent.push({
                            url: String(url),
                            method: init?.method ?? "GET",
                            headers: new Headers(init?.headers),
                            body: JSON.parse(String(init?.body)),
                        });
                        return Promise.resolve(
                            Response.json(response.body, {
                                status: response.status,
                            }),
                        );
                    },
                }),
            }).load(unit);
            const result = await loaded.run({
                body: {
                    ...input,
                    background: "transparent",
                    ...(edit ? { mask: "https://example.com/mask.png" } : {}),
                },
            });
            assertEquals(sent.length, 1);
            assertEquals(
                sent[0].url,
                `https://api.openai.com/v1/images/${
                    edit ? "edits" : "generations"
                }`,
            );
            assertEquals(sent[0].method, "POST");
            assertEquals(
                sent[0].headers.get("authorization"),
                "Bearer test-key",
            );
            assertEquals(
                sent[0].headers.get("content-type"),
                "application/json",
            );
            assertEquals(sent[0].body, {
                ...INPUT,
                background: "transparent",
                model,
                n: 1,
                output_format: "png",
                stream: false,
                ...(edit
                    ? {
                        images: REFERENCES.map((image_url) => ({ image_url })),
                        mask: { image_url: "https://example.com/mask.png" },
                    }
                    : {}),
            });
            assertEquals(result.httpStatus, 200);
            assertEquals(result.output, response.body);
            assertEquals(result.usage.evidence, {
                input_text_token: 20,
                input_image_token: 1000,
                output_image_token: 196,
            });
            assertAlmostEquals(result.usage.credits.default, 0.01398, EPSILON);
        });

        Deno.test(`${id}: reference estimate is based on caller strings before wire conversion`, async () => {
            const unit = await testSealedUnit(id);
            const base = await estimateEndpoint(unit, { body: input });
            assertEquals(base.evidence, {
                input_text_token: INPUT.prompt.length,
                input_image_token: edit ? 3000 : 0,
                output_image_token: 196,
            });
            if (edit) {
                const masked = await estimateEndpoint(unit, {
                    body: { ...input, mask: "https://example.com/mask.png" },
                });
                assertEquals(masked.evidence.input_image_token, 4500);
            }
        });

        Deno.test(`${id}: moderation and HTTP errors preserve vendor errors and bill zero`, async () => {
            const unit = await testSealedUnit(id);
            for (
                const name of [
                    "moderation-blocked",
                    "http-error",
                    ...(edit ? ["download-error"] : []),
                ]
            ) {
                const replay = await fixture(name);
                const result = await runEndpoint({
                    unit,
                    input: { body: input },
                    mode: "replay",
                    fixture: replay,
                });
                assertEquals(result.httpStatus, replay.calls[0].res.status);
                assertEquals(result.isProviderError, true);
                assertEquals(result.output, replay.calls[0].res.body);
                assertEquals(result.usage, { credits: {}, evidence: {} });
            }
        });

        Deno.test(`${id}: required knobs and caller overrides fail before any wire call`, async () => {
            const unit = await testSealedUnit(id);
            const invalid: RunInput["body"][] = [
                { ...input, prompt: "" },
                { ...input, prompt: "x".repeat(32001) },
                { ...input, size: "auto" },
                { ...input, size: "1024" },
                { ...input, quality: "auto" },
                { ...input, model: "gpt-image-2" },
                { ...input, n: 2 },
                { ...input, output_format: "jpeg" },
                { ...input, stream: true },
                Object.fromEntries(
                    Object.entries(input).filter(([key]) => key !== "size"),
                ) as RunInput["body"],
                Object.fromEntries(
                    Object.entries(input).filter(([key]) => key !== "quality"),
                ) as RunInput["body"],
            ];
            if (model === "gpt-image-2") {
                invalid.push({ ...input, quality: "xhigh" }, {
                    ...input,
                    quality: "max",
                });
            }
            if (edit) {
                invalid.push(
                    { ...input, images: [] },
                    { ...input, images: Array(17).fill(REFERENCES[0]) },
                    { ...input, images: ["http://example.com/a.png"] },
                    { ...input, images: ["https://?"] },
                    { ...input, images: ["https://#"] },
                    { ...input, mask: "https://?" },
                    { ...input, mask: "https://#" },
                    { ...input, images: [{ image_url: REFERENCES[0] }] },
                    { ...input, mask: "data:image/png;base64,abc" },
                    Object.fromEntries(
                        Object.entries(input).filter(([key]) =>
                            key !== "images"
                        ),
                    ) as RunInput["body"],
                );
            }
            for (const body of invalid) {
                await assertRejects(
                    () =>
                        runEndpoint({ unit, input: { body }, mode: "replay" }),
                    Error,
                    "INVALID_INPUT",
                );
            }
        });
    }
}

// Published calculator reference values, deliberately not calculated by the
// implementation in these tests. Covers all tiers, orientation and round-even.
// Near-half cases also pin the official calculator's floating-point evaluation
// order: edge / (long / short), which can differ from edge * short / long.
for (
    const [model, cases] of [
        ["gpt-image-2", [
            ["1024x1024", "low", 196],
            ["1024x1024", "medium", 1756],
            ["1024x1024", "high", 7024],
            ["1536x1024", "medium", 1372],
            ["1024x1536", "medium", 1372],
            ["2560x1024", "low", 111],
            ["2048x832", "low", 89],
            ["2048x960", "low", 127],
            ["944x1536", "medium", 1201],
            ["1536x944", "medium", 1201],
            ["1888x3072", "medium", 2715],
        ]],
        ["gpt-image-2.5-sunburst", [
            ["1024x1024", "medium", 439],
            ["1024x1024", "high", 1756],
            ["1024x1024", "xhigh", 3122],
            ["1024x1024", "max", 7024],
            ["944x1536", "high", 1201],
            ["1536x944", "high", 1201],
            ["784x2048", "xhigh", 1443],
            ["2048x784", "xhigh", 1443],
            ["1584x2048", "xhigh", 4112],
            ["1968x2048", "xhigh", 5886],
            ["2560x1024", "medium", 278],
        ]],
        ["gpt-image-2.5-flare", [
            ["1024x1024", "medium", 439],
            ["1024x1024", "high", 1756],
            ["1024x1024", "xhigh", 3122],
            ["1024x1024", "max", 7024],
            ["944x1536", "high", 1201],
            ["1536x944", "high", 1201],
            ["784x2048", "xhigh", 1443],
            ["2048x784", "xhigh", 1443],
            ["1584x2048", "xhigh", 4112],
            ["1968x2048", "xhigh", 5886],
        ]],
    ] as const
) {
    Deno.test(`openai#${model}: size and quality follow official output token calculator`, async () => {
        for (const edit of [false, true]) {
            const unit = await testSealedUnit(
                `openai#v1/image/${model}${edit ? "-edit" : ""}`,
            );
            for (const [size, quality, expected] of cases) {
                const estimate = await estimateEndpoint(unit, {
                    body: {
                        ...INPUT,
                        size,
                        quality,
                        ...(edit ? { images: [REFERENCES[0]] } : {}),
                    },
                });
                assertEquals(
                    estimate.evidence.output_image_token,
                    expected,
                    `${size} ${quality}`,
                );
            }
        }
    });
}

Deno.test("openai: UTF-8 prompt estimate handles Chinese, emoji and a lone surrogate", async () => {
    const unit = await testSealedUnit("openai#v1/image/gpt-image-2");
    const estimate = await estimateEndpoint(unit, {
        body: { ...INPUT, prompt: "a\u732b\u{1f436}\ud800" },
    });
    assertEquals(estimate.evidence.input_text_token, 11);
});

Deno.test("openai: unsupported dimensions are refused without network or charges", async () => {
    for (const edit of [false, true]) {
        const unit = await testSealedUnit(
            `openai#v1/image/gpt-image-2${edit ? "-edit" : ""}`,
        );
        for (
            const size of [
                "1025x1024",
                "4000x1024",
                "1024x256",
                "512x512",
                "3840x3840",
                "999999999999999999999x1024",
            ]
        ) {
            const body = {
                ...INPUT,
                size,
                ...(edit ? { images: REFERENCES } : {}),
            };
            const result = await runEndpoint({
                unit,
                input: { body },
                mode: "replay",
            });
            assertEquals(result.httpStatus, 400);
            assertEquals(result.usage, { credits: {}, evidence: {} });
            await assertRejects(
                () => estimateEndpoint(unit, { body }),
                Error,
                "invalid_size",
            );
        }
        for (
            const size of ["640x1024", "3840x2160", "2160x3840", "2048x2048"]
        ) {
            const body = {
                ...INPUT,
                size,
                ...(edit ? { images: REFERENCES } : {}),
            };
            const result = await runEndpoint({
                unit,
                input: { body },
                mode: "replay",
                fixture: await fixture(),
            });
            assertEquals(result.httpStatus, 200);
        }
    }
});

Deno.test("openai: a 2xx in-body error is a zero-billed provider failure", async () => {
    const unit = await testSealedUnit("openai#v1/image/gpt-image-2");
    const error = { error: { code: "moderation_blocked", message: "blocked" } };
    const result = await runBody(unit, error);
    assertEquals(result.httpStatus, 502);
    assertEquals(result.providerHttpStatus, 200);
    assertEquals(result.output, error);
    assertEquals(result.usage, { credits: {}, evidence: {} });
});

Deno.test("openai: absent images and incomplete/invalid meters never bill", async () => {
    const unit = await testSealedUnit("openai#v1/image/gpt-image-2");
    const image = { data: [{ b64_json: PNG_BASE64 }] };
    const receipt = {
        usage: {
            input_tokens_details: { text_tokens: 20, image_tokens: 0 },
            output_tokens: 196,
        },
    };
    for (
        const output of [
            {},
            { ...receipt, data: [] },
            { ...receipt, data: [{ b64_json: "" }] },
            { ...receipt, data: [{ b64_json: " " }] },
            { ...receipt, data: [{ b64_json: "not-base64!" }] },
            { ...receipt, data: [{ b64_json: "aGVsbG8=" }] },
            { ...receipt, data: [{ b64_json: PNG_BASE64.slice(0, -1) }] },
            { ...receipt, data: [{ b64_json: PNG_BASE64 + "====" }] },
            {
                ...receipt,
                data: [{ url: "https://example.com/invalid-response.png" }],
            },
            image,
            { ...image, usage: { output_tokens: 196 } },
            { ...image, usage: { ...receipt.usage, output_tokens: -1 } },
            { ...image, usage: { ...receipt.usage, output_tokens: 1.5 } },
            { ...image, usage: { ...receipt.usage, output_tokens: "196" } },
            {
                ...image,
                usage: {
                    ...receipt.usage,
                    input_tokens_details: { text_tokens: 20 },
                },
            },
        ]
    ) {
        const result = await runBody(unit, output);
        assertEquals(result.httpStatus, 502);
        assertEquals(result.providerHttpStatus, 200);
        assertEquals(result.usage, { credits: {}, evidence: {} });
    }
});

Deno.test("openai: settlement uses actual tokens even when estimate differs; no 1K rounding", async () => {
    const unit = await testSealedUnit("openai#v1/image/gpt-image-2");
    const body = {
        data: [{ b64_json: PNG_BASE64 }],
        usage: {
            input_tokens_details: { text_tokens: 1, image_tokens: 1 },
            output_tokens: 1,
        },
    };
    const result = await runBody(unit, body);
    assertEquals(result.usage.evidence, {
        input_text_token: 1,
        input_image_token: 1,
        output_image_token: 1,
    });
    assertAlmostEquals(result.usage.credits.default, 0.000043, EPSILON);
});

Deno.test("openai: maximum reference count preserves order and optional mask is omitted", async () => {
    const unit = await testSealedUnit(
        "openai#v1/image/gpt-image-2.5-flare-edit",
    );
    const images = Array.from(
        { length: 16 },
        (_, index) => `https://example.com/${index}.png`,
    );
    let sent: Record<string, Json> = {};
    const loaded = await new Engine({
        transport: directTransport({
            params: () => Promise.resolve({ apiKey: "test-key" }),
            fetch: (_url, init) => {
                sent = JSON.parse(String(init?.body));
                return Promise.resolve(
                    Response.json({
                        data: [{ b64_json: PNG_BASE64 }],
                        usage: {
                            input_tokens_details: {
                                text_tokens: 1,
                                image_tokens: 16000,
                            },
                            output_tokens: 196,
                        },
                    }),
                );
            },
        }),
    }).load(unit);
    await loaded.run({ body: { ...INPUT, images } });
    assertEquals(sent.images, images.map((image_url) => ({ image_url })));
    assertEquals("mask" in sent, false);
    assertEquals("background" in sent, false);
    assertEquals(
        (await estimateEndpoint(unit, { body: { ...INPUT, images } })).evidence
            .input_image_token,
        24000,
    );
});

Deno.test({
    name:
        "openai live: low-quality PNG and usage receipt (gated on OPENAI_CREDENTIALS_API_KEY)",
    ignore: liveSkip("openai"),
    fn: async () => {
        const result = await runEndpoint({
            unit: await testSealedUnit(
                "openai#v1/image/gpt-image-2.5-sunburst",
            ),
            input: { body: INPUT },
            mode: "live",
        });
        assertEquals(
            result.isProviderError,
            false,
            JSON.stringify(result.output),
        );
        assert(result.usage.evidence.output_image_token > 0);
        assert(result.usage.credits.default > 0);
    },
});
