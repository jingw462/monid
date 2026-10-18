import { defineEndpoint } from "@shared/core";
import {
    zEditBody,
    zImage2Quality,
    zImageSize,
    zPublicImages,
    zPublicMask,
} from "../../schema/inputs.ts";
import { imageUsageModel } from "../../schema/usage.ts";

export default defineEndpoint({
    meta: {
        displayName: "GPT Image 2 Edit",
        summary:
            "Edit or compose a PNG with GPT Image 2 and up to 16 reference images.",
        description:
            "Edit or compose a PNG with GPT Image 2 and up to 16 reference images. " +
            "Choose an explicit size and quality to set the output token budget. " +
            "Supports transparent PNG backgrounds and custom sizes up to 4K. " +
            "Returns data[].b64_json and the native token usage receipt. " +
            "Only a successful image is billed at the reported text/image token counts.",
        docsUrl:
            "https://developers.openai.com/api/reference/resources/images/methods/edit",
        categories: ["image-generation"],
        notes: [
            "Generation can take up to two minutes at the highest quality tiers.",
            "Output is inline PNG base64; signed download links require host artifact storage.",
            "The estimate uses the official output token formula, a byte-based prompt " +
            "estimate and 1,500 tokens per reference image (including a mask, if present). " +
            "Actual billing uses only the response usage receipt.",
            "Vendor errors, including moderation and unreachable references, settle at zero.",
        ],
    },
    endpoint: "/v1/image/gpt-image-2-edit",
    request: { method: "POST", path: "/v1/images/edits" },
    input: {
        schema: {
            // Price-setting knobs are required at the binding (D25).
            body: zEditBody.required({ size: true, quality: true }).extend({
                size: zImageSize,
                quality: zImage2Quality,
                images: zPublicImages,
                mask: zPublicMask.optional(),
            }),
        },
        toRequest: ({ data, utils }) => {
            const body = data.input.body ?? {};
            const mask = utils.json.optionalStr(body, "$.mask");
            const images = utils.json.get(body, "$.images");
            if (!Array.isArray(images)) {
                throw new Error("validated images must be an array");
            }
            return {
                ...data.input,
                body: utils.json.merge(body, {
                    model: "gpt-image-2",
                    n: 1,
                    output_format: "png",
                    stream: false,
                    images: images.map((
                        image_url,
                    ) => ({ image_url })),
                    ...(mask === undefined
                        ? {}
                        : { mask: { image_url: mask } }),
                }),
            };
        },
    },
    usage: {
        model: imageUsageModel,
        /** Official calculator: model-specific latent edge, short-edge
         * round-to-even, then ceil(patches * (2M + pixels) / 4M).
         * https://developers.openai.com/api/docs/guides/image-generation
         * Prompt bytes approximate a conservative text-token budget without
         * fetching a tokenizer; URL inputs use Monid's documented 1,500 allowance.
         */
        estimate: ({ data }) => {
            const body = data.input.body;
            const [width, height] = body.size.split("x").map(Number);
            const pixels = width * height;
            if (
                !Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
                width % 16 !== 0 || height % 16 !== 0 ||
                Math.max(width, height) > 3840 ||
                Math.max(width, height) / Math.min(width, height) > 3 ||
                pixels < 655360 || pixels > 8294400
            ) {
                throw new Error("invalid_size: unsupported output dimensions");
            }
            const grid = { low: 16, medium: 48, high: 96 };
            const longEdge = grid[body.quality];
            const shortExact = longEdge /
                (Math.max(width, height) / Math.min(width, height));
            const floor = Math.floor(shortExact);
            const shortEdge = shortExact - floor === 0.5
                ? floor + floor % 2
                : Math.round(shortExact);
            const outputTokens = Math.ceil(
                longEdge * shortEdge * (2000000 + pixels) / 4000000,
            );
            let promptBytes = 0;
            for (const character of body.prompt) {
                const code = character.codePointAt(0) ?? 0;
                promptBytes += code <= 0x7f
                    ? 1
                    : code <= 0x7ff
                    ? 2
                    : code <= 0xffff
                    ? 3
                    : 4;
            }
            return {
                counts: {
                    input_text_token: promptBytes,
                    input_image_token: 1500 *
                        (body.images.length +
                            (body.mask === undefined ? 0 : 1)),
                    output_image_token: outputTokens,
                },
            };
        },
        evidence: ({ data, utils }) => ({
            counts: {
                input_text_token: utils.json.num(
                    data.output,
                    "$.usage.input_tokens_details.text_tokens",
                ),
                input_image_token: utils.json.num(
                    data.output,
                    "$.usage.input_tokens_details.image_tokens",
                ),
                output_image_token: utils.json.num(
                    data.output,
                    "$.usage.output_tokens",
                ),
            },
        }),
    },
});
